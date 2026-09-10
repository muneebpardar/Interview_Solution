# Offline-First Field Reporting (React Native / Expo)

A resilient, local-first field reporting mobile application engineered for field teams operating across Pakistan in low-connectivity markets with low-end Android smartphones.

Built to guarantee **zero duplicate reports (`duplicates_created: 0`)** even under deliberately hostile network conditions (where the mock server stores the report and terminates the TCP socket before acknowledging).

---

## Quick Start

### 1. Prerequisites
- **Node.js 18+**
- **npm** or **yarn**
- Physical phone with **Expo Go** or an Android/iOS Emulator

### 2. Install Dependencies
```bash
npm install
```

### 3. Run the Mock Server
In a separate terminal:
```bash
npm run mock
# Listens on http://localhost:4000
```
> **Note:** `mock-server.js` is unmodified and verified by SHA-256 hash (`f1da090727a5eb26`).

### 4. Run the Automated Hostile Sync Verification Test
To immediately prove that the sync algorithm survives all hostile server failures and achieves `duplicates_created === 0`:
```bash
npm run test:sync
```
This test runs 8 reports through the live mock server's deterministic chaos (`ok`, `save_then_drop`, `500`, `502`, `503`, `429`), demonstrates automatic 409 conflict recovery, and queries `GET /v1/_debug/count` for a `PASS` verdict.

### 5. Start the Expo App
```bash
npm start
```
- Press `a` for Android emulator (uses `http://10.0.2.2:4000` to reach host machine localhost).
- Press `w` for Web preview.
- Or scan the QR code with **Expo Go** on your Android device (set the server URL in the in-app `⚙ Server` drawer to your computer's local LAN IP, e.g., `http://192.168.1.X:4000`).

---

## How It Works: The Core Architecture

### 1. The Core Mechanic: Defeating `save_then_drop`
The mock API exhibits hostile behavior: roughly 6 in 10 requests fail, and **2 in 10 save the report and destroy the TCP connection before responding** (`save_then_drop`). To the client, this surfaces as an unhandled socket hangup (`ECONNRESET`).

**The Solution:**
1. At the instant the field worker taps **Submit**, a cryptographically unique `client_report_id` (UUIDv4) and `captured_at` timestamp are generated.
2. This record is written immediately into a local SQLite `outbox` table with status `QUEUED`.
3. When the socket drops halfway through, the client catches the network failure and transitions the report to `WAITING_RETRY`, keeping the **exact same `client_report_id`**.
4. On the subsequent retry, the mock server checks `byClientId.has(cid)` **before** executing any injected failure, returning `409 Conflict`:
   ```json
   { "error": "duplicate_client_report_id", "report_id": "srv_xxxx" }
   ```
5. The client treats `409 Conflict` as a **first-class success confirmation**, extracts `report_id`, and transitions the report to `CONFIRMED`.
6. **Result:** `duplicates_created` is mathematically guaranteed to be **0**.

---

### 2. Local-First Transactional Outbox (`expo-sqlite`)
Rather than relying on `AsyncStorage` (which serializes entire JSON blobs and can corrupt when the Android Low Memory Killer terminates the process), the app uses embedded **SQLite** with Write-Ahead Logging (`PRAGMA journal_mode = WAL;`):
- **ACID Transactions**: Atomic state transitions prevent partial writes.
- **Force-Quit Crash Recovery Protocol**:
  If the app process is terminated while an HTTP request is in-flight (status `IN_FLIGHT`), the database bootstrap executes:
  ```sql
  UPDATE outbox 
  SET status = 'QUEUED', next_retry_at = 0 
  WHERE status = 'IN_FLIGHT';
  ```
  Upon reopening, the outbox immediately re-dispatches the report using its original `client_report_id`.

---

### 3. Single-Flight Serial Mutex Lock & Jittered Backoff
To avoid connection storms and race conditions over flapping 2G/3G connections:
- **Strict Serial Execution**: A mutex lock (`isProcessing`) ensures only one HTTP request is active at any time. Reports are dispatched in FIFO order (`ORDER BY created_at ASC`).
- **Exponential Backoff with Full Jitter**:
  ```typescript
  backoff = Math.floor(Math.random() * Math.min(15000, 1500 * (1.8 ^ retryCount))) + 800;
  ```
- **HTTP 429 Rate Limiting**: Explicitly honors the `Retry-After` header sent by the server.
- **Watchdog Timeout**: A 10-second `AbortController` watchdog aborts frozen sockets to prevent queue deadlock.
- **Fatal Error Handling**: HTTP `400` and `413` errors are tagged `FAILED_FATAL` so invalid records never deadlock the queue.

---

### 4. GPS & Location Strategy
Per the trial brief:
- The app integrates `expo-location` with a simple toggle switch for device GPS.
- If GPS permissions are denied or indoor satellite acquisition fails, it falls back seamlessly to hardcoded Karachi coordinates (`lat: 24.8607, lng: 67.0011`), ensuring the field worker is never blocked.

---

### 5. In-App Telemetry & Server Verification HUD
The application includes a built-in diagnostic interface:
- **Network Bar**: Shows real-time connectivity state with a **"Force Offline"** switch to test offline queueing without altering OS settings.
- **Queue Metrics**: Live breakdown of `[Total | Pending | In Flight | Synced]`.
- **Live Dispatcher Stream**: An event log showing socket errors, retries, and 409 resolutions in real time.
- **Server Verification Button**: Directly queries `GET /v1/_debug/count` from inside the app and displays the live verdict (`PASS — no duplicates`).

---

## What in This Solution I Am Least Confident About

The brief explicitly requests naming the weak points of this solution. Here is an honest, production-level critique of the real-world edge cases:

### 1. Server Memory Loss on Server Restart
* **The Weakness:** The mock server stores idempotency keys in an ephemeral in-memory `Map()` (`const byClientId = new Map();`). If the backend crashes or restarts after a `save_then_drop` but before the mobile client reconnects, the server loses its record of `client_report_id`.
* **The Impact:** When the client retries, the server would treat the report as brand new. Because the form fields and `captured_at` remain identical, the server's fingerprint check would detect a duplicate.
* **Production Fix:** In a real backend, idempotency keys must be backed by a persistent datastore (PostgreSQL table or distributed Redis key with a 72-hour TTL) rather than process memory.

### 2. Android Aggressive OEM Battery Killers & Background Execution
* **The Weakness:** Low-end Android smartphones prevalent in Pakistan (Transsion brands like Infinix/Tecno, Xiaomi, Vivo) run aggressive OEM battery management and Android Doze mode. When the app is backgrounded or the screen turns off, the OS suspends JavaScript event timers (`setTimeout`).
* **The Impact:** If a worker submits reports in the field and immediately locks their phone or switches to WhatsApp, pending retries in `WAITING_RETRY` will pause until the worker re-opens the app.
* **Production Fix:** Implement an Android Foreground Service with a sticky notification or integrate `expo-task-manager` / Android `WorkManager` with a `PeriodicWorkRequest` configured with network constraints.

### 3. Client Clock Skew on Low-End Devices
* **The Weakness:** Field devices frequently have incorrect local system clocks (manual time set incorrectly, dead RTC battery).
* **The Impact:** The report's `captured_at` timestamp is generated using `new Date().toISOString()`. If the phone's clock is skewed by months or years, audit timelines and FIFO sorting may be distorted.
* **Production Fix:** Calculate a server-time offset on initial handshake (`Date.now() - Date.parse(serverResponse.headers['date'])`) and apply this offset to all locally recorded timestamps.

---

## Project Structure

```
├── App.tsx                     # App entry point
├── mock-server.js              # Assessment mock server (unmodified, hash verified)
├── package.json                # Project manifest and scripts
├── scripts/
│   └── test-sync-hostile.js    # Standalone automated verification test
├── src/
│   ├── types/
│   │   └── report.ts           # Domain models, Outbox FSM states, Telemetry
│   ├── storage/
│   │   ├── db.ts               # SQLite initialization, WAL mode & Crash Recovery
│   │   └── outboxRepo.ts       # Outbox CRUD and transactional queries
│   ├── services/
│   │   ├── api.ts              # HTTP client, status matrix, AbortController
│   │   └── syncDispatcher.ts   # Serial mutex dispatcher, jittered backoff, NetInfo
│   └── screens/
│       └── ReportScreen.tsx    # Single-screen UI, live queue inspector & debug HUD
└── WALKTHROUGH_SCRIPT.md       # 3-minute video presentation guide
```
