/*
 * Field Reports ? mock API server for the trial task.
 *
 * DO NOT MODIFY THIS FILE. It is how your work is assessed, and the same file is
 * used for every candidate. It reports a hash of its own source; if the hash does
 * not match, we know it was edited.
 *
 * Run:  node mock-server.js          (listens on http://localhost:4000)
 * Port: PORT=5000 node mock-server.js
 *
 * Zero dependencies. Node 18+.
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");

const PORT = Number(process.env.PORT || 4000);
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const SELF_HASH = crypto
  .createHash("sha256")
  .update(fs.readFileSync(__filename))
  .digest("hex")
  .slice(0, 16);

/* ------------------------------------------------------------------ *
 * Deterministic chaos.
 * Every candidate meets the same sequence, so results are comparable.
 * "save_then_drop" = the report IS stored, then the connection dies
 * before the client hears back. This is the case that matters.
 * ------------------------------------------------------------------ */
const OUTCOMES = [
  "ok",
  "save_then_drop",
  "fail_503",
  "ok",
  "fail_500",
  "save_then_drop",
  "fail_429",
  "ok",
  "fail_502",
  "ok",
];

let attemptSeq = 0;

/* ---------------------------- state ---------------------------- */
const reports = new Map();       // report_id -> record
const byClientId = new Map();    // client_report_id -> report_id
const stats = {
  create_attempts: 0,
  stored: 0,
  conflicts_409: 0,
  injected_failures: 0,
  save_then_drop: 0,
  rejected_400: 0,
  rejected_413: 0,
};

const fingerprint = (b) =>
  crypto
    .createHash("sha256")
    .update(
      [
        String(b.outlet_name || ""),
        String(b.finding || ""),
        String(b.action_needed || ""),
        String(b.captured_at || ""),
        String(b.lat),
        String(b.lng),
        String((b.photo || "").length),
      ].join("|")
    )
    .digest("hex")
    .slice(0, 12);

const send = (res, code, obj, headers = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
};

const latency = () => 800 + Math.floor(Math.random() * 5200); // 0.8s - 6s

/* ---------------------------- server ---------------------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  /* ---- debug: the only endpoints that answer instantly ---- */
  if (path === "/v1/_debug/count" && req.method === "GET") {
    const seen = new Map();
    for (const r of reports.values()) seen.set(r.fingerprint, (seen.get(r.fingerprint) || 0) + 1);
    let duplicates_created = 0;
    const duplicate_groups = [];
    for (const [fp, n] of seen) {
      if (n > 1) {
        duplicates_created += n - 1;
        duplicate_groups.push({ fingerprint: fp, stored_copies: n });
      }
    }
    return send(res, 200, {
      server_hash: SELF_HASH,
      VERDICT: duplicates_created === 0 ? "PASS ? no duplicates" : "FAIL ? duplicate reports stored",
      distinct_submissions: seen.size,
      reports_stored: reports.size,
      duplicates_created,
      duplicate_groups,
      used_client_report_id: byClientId.size > 0,
      ...stats,
    });
  }

  if (path === "/v1/_debug/reset" && req.method === "POST") {
    reports.clear();
    byClientId.clear();
    attemptSeq = 0;
    for (const k of Object.keys(stats)) stats[k] = 0;
    return send(res, 200, { reset: true, server_hash: SELF_HASH });
  }

  /* ---- GET /v1/reports/{id} ---- */
  if (req.method === "GET" && path.startsWith("/v1/reports/")) {
    const id = decodeURIComponent(path.slice("/v1/reports/".length));
    const r = reports.get(id);
    return setTimeout(() => {
      if (!r) return send(res, 404, { error: "not_found" });
      send(res, 200, {
        report_id: r.report_id,
        outlet_name: r.outlet_name,
        received_at: r.received_at,
      });
    }, latency());
  }

  /* ---- POST /v1/reports ---- */
  if (req.method === "POST" && path === "/v1/reports") {
    let raw = "";
    let tooBig = false;
    req.on("data", (c) => {
      raw += c;
      if (raw.length > MAX_PHOTO_BYTES + 512 * 1024) tooBig = true;
    });
    req.on("end", () => {
      stats.create_attempts++;
      const outcome = OUTCOMES[attemptSeq % OUTCOMES.length];
      attemptSeq++;
      const wait = latency();

      setTimeout(() => {
        if (tooBig) {
          stats.rejected_413++;
          return send(res, 413, { error: "photo_too_large", limit_bytes: MAX_PHOTO_BYTES });
        }

        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          stats.rejected_400++;
          return send(res, 400, { error: "malformed_json" });
        }

        for (const f of ["outlet_name", "finding", "action_needed", "captured_at"]) {
          if (!body[f] || typeof body[f] !== "string") {
            stats.rejected_400++;
            return send(res, 400, { error: "missing_or_invalid_field", field: f });
          }
        }
        if (typeof body.lat !== "number" || typeof body.lng !== "number") {
          stats.rejected_400++;
          return send(res, 400, { error: "missing_or_invalid_field", field: "lat/lng" });
        }
        if (body.photo && Buffer.byteLength(body.photo, "utf8") > MAX_PHOTO_BYTES) {
          stats.rejected_413++;
          return send(res, 413, { error: "photo_too_large", limit_bytes: MAX_PHOTO_BYTES });
        }

        // Idempotency ? checked BEFORE any injected failure, as a real server would.
        const cid = body.client_report_id;
        if (cid && byClientId.has(cid)) {
          stats.conflicts_409++;
          return send(res, 409, {
            error: "duplicate_client_report_id",
            report_id: byClientId.get(cid),
          });
        }

        const store = () => {
          const report_id = "srv_" + crypto.randomBytes(6).toString("hex");
          const rec = {
            report_id,
            outlet_name: body.outlet_name,
            received_at: new Date().toISOString(),
            fingerprint: fingerprint(body),
            client_report_id: cid || null,
          };
          reports.set(report_id, rec);
          if (cid) byClientId.set(cid, report_id);
          stats.stored++;
          return rec;
        };

        switch (outcome) {
          case "ok": {
            const rec = store();
            return send(res, 201, { report_id: rec.report_id, received_at: rec.received_at });
          }
          case "save_then_drop": {
            // Stored successfully ? then the connection dies before the client hears.
            store();
            stats.save_then_drop++;
            stats.injected_failures++;
            return setTimeout(() => res.socket && res.socket.destroy(), 1200);
          }
          case "fail_429":
            stats.injected_failures++;
            return send(res, 429, { error: "rate_limited" }, { "retry-after": "3" });
          case "fail_500":
          case "fail_502":
          case "fail_503": {
            stats.injected_failures++;
            const code = Number(outcome.split("_")[1]);
            return send(res, code, { error: "server_error" });
          }
        }
      }, wait);
    });
    return;
  }

  send(res, 404, { error: "no_such_route" });
});

server.listen(PORT, () => {
  console.log(`Field Reports mock API  ->  http://localhost:${PORT}`);
  console.log(`  server_hash : ${SELF_HASH}   (do not modify this file)`);
  console.log(`  POST   /v1/reports`);
  console.log(`  GET    /v1/reports/{id}`);
  console.log(`  GET    /v1/_debug/count     <- the assessment reads this`);
  console.log(`  POST   /v1/_debug/reset`);
  console.log(`\n  Roughly 6 in 10 requests fail. Two of every ten SAVE the report`);
  console.log(`  and then drop the connection before answering. That is the point.\n`);
});
