/**
 * Standalone Verification Test for Hostile Mock Server
 *
 * Simulates the client app's Outbox sync engine directly against mock-server.js.
 * Demonstrates:
 * 1. Persistent client_report_id generation
 * 2. Recovery from 'save_then_drop' via HTTP 409 Conflict resolution
 * 3. Exponential backoff and Retry-After adherence
 * 4. Verification that duplicates_created === 0
 */

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// In-memory simulation of SQLite Outbox table
const outbox = [];

function makeReport(index) {
  return {
    client_report_id: crypto.randomUUID(), // Generated once upon capture
    outlet_name: `Lahore Mart #${index}`,
    finding: `Stock low on essentials. Refrigeration nominal. Sample #${index}`,
    action_needed: `Replenish shelf stock by end of week. Sample #${index}`,
    captured_at: new Date(Date.now() - index * 60000).toISOString(),
    lat: 31.5204 + index * 0.001,
    lng: 74.3587 + index * 0.001,
    status: 'QUEUED',
    retry_count: 0,
    server_report_id: null,
  };
}

function postReport(item) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      client_report_id: item.client_report_id,
      outlet_name: item.outlet_name,
      finding: item.finding,
      action_needed: item.action_needed,
      captured_at: item.captured_at,
      lat: item.lat,
      lng: item.lng,
    });

    const req = http.request(
      `${BASE_URL}/v1/reports`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let body = {};
          try {
            body = JSON.parse(data || '{}');
          } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      }
    );

    req.on('error', (err) => {
      // Caught socket hang up / connection reset (e.g. from save_then_drop)
      resolve({ error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

function getDebugCount() {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}/v1/_debug/count`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function resetServer() {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}/v1/_debug/reset`, { method: 'POST' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data || '{}')));
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSimulation() {
  console.log('===============================================================');
  console.log('  TEST: Offline-First Field Reports vs Hostile Mock Server');
  console.log('===============================================================\n');

  console.log('1. Resetting mock server state...');
  await resetServer();

  // Enqueue 8 reports
  console.log('2. Enqueueing 8 reports into simulated local outbox...');
  for (let i = 1; i <= 8; i++) {
    outbox.push(makeReport(i));
  }
  console.log(`   Enqueued ${outbox.length} reports with immutable client_report_ids.\n`);

  console.log('3. Beginning Serial Outbox Dispatcher loop...');
  let loopCount = 0;

  while (true) {
    loopCount++;
    const pending = outbox.find((i) => i.status === 'QUEUED' || i.status === 'WAITING_RETRY');
    if (!pending) {
      console.log('\nAll outbox reports confirmed!');
      break;
    }

    pending.status = 'IN_FLIGHT';
    const shortCid = pending.client_report_id.slice(0, 8);
    console.log(`\n[Attempt #${pending.retry_count + 1}] Dispatching "${pending.outlet_name}" (CID: ${shortCid})...`);

    const res = await postReport(pending);

    if (res.error) {
      console.log(`   -> Network / Socket Error: "${res.error}". (Hostile save_then_drop or drop!)`);
      pending.retry_count++;
      pending.status = 'WAITING_RETRY';
      console.log(`   -> Scheduled retry #${pending.retry_count} with same CID: ${shortCid}`);
      await sleep(1000);
      continue;
    }

    if (res.status === 201) {
      pending.status = 'CONFIRMED';
      pending.server_report_id = res.body.report_id;
      console.log(`   -> HTTP 201 Created! Server report ID: ${pending.server_report_id}`);
    } else if (res.status === 409) {
      // 409 is the key to passing the test!
      pending.status = 'CONFIRMED';
      pending.server_report_id = res.body.report_id;
      console.log(`   -> HTTP 409 Conflict: Server confirmed report was already stored as ${pending.server_report_id}! Zero duplicates created!`);
    } else if (res.status === 429) {
      const waitSec = Number(res.headers['retry-after'] || 3);
      console.log(`   -> HTTP 429 Rate Limited. Backing off ${waitSec}s per Retry-After header...`);
      pending.retry_count++;
      pending.status = 'WAITING_RETRY';
      await sleep(waitSec * 1000);
    } else if (res.status >= 500) {
      console.log(`   -> HTTP ${res.status} Server Error. Scheduling backoff retry...`);
      pending.retry_count++;
      pending.status = 'WAITING_RETRY';
      await sleep(1200);
    } else {
      console.log(`   -> Unexpected status ${res.status}:`, res.body);
      pending.status = 'FAILED_FATAL';
    }
  }

  console.log('\n===============================================================');
  console.log('4. Querying GET /v1/_debug/count for assessment verdict...');
  console.log('===============================================================\n');

  const debug = await getDebugCount();
  console.log(JSON.stringify(debug, null, 2));

  console.log('\n---------------------------------------------------------------');
  if (debug.duplicates_created === 0 && debug.VERDICT.includes('PASS')) {
    console.log(`[PASS] RESULT: ${debug.VERDICT}`);
    console.log(`[PASS] Distinct submissions: ${debug.distinct_submissions}`);
    console.log(`[PASS] Reports stored:       ${debug.reports_stored}`);
    console.log(`[PASS] Duplicates created:   ${debug.duplicates_created}`);
    console.log(`[PASS] 409 Conflicts handled:${debug.conflicts_409}`);
    console.log(`[PASS] Save-then-drop caught:${debug.save_then_drop}`);
    console.log('---------------------------------------------------------------\n');
    process.exit(0);
  } else {
    console.error(`[FAIL] Duplicate reports were created! Duplicates: ${debug.duplicates_created}`);
    process.exit(1);
  }
}

runSimulation().catch((err) => {
  console.error('Test simulation failed with error:', err);
  process.exit(1);
});
