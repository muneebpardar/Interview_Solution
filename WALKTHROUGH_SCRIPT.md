# 3-Minute Video Walkthrough Script

Use this script to guide your screen recording (Loom or phone recording). It is structured to hit every evaluation criterion in under 3 minutes.

---

### [0:00 – 0:45] Introduction & The Idempotency Key
* **What to show on screen:** Open `src/storage/outboxRepo.ts` and `mock-server.js` (lines 185–192 side-by-side).
* **What to say:**
  > *"Hi everyone, here is the walkthrough for the offline-first field reporting app.*
  > 
  > *The core challenge in this brief is handling `save_then_drop`: the mock server stores our report, but kills the TCP socket before answering. To the phone, that looks like a network failure, but the server already has the report.*
  > 
  > *To ensure we never create a duplicate, we use a **Local-First Transactional Outbox Pattern**. When the worker taps Submit, we generate a cryptographically unique `client_report_id` (UUIDv4) and write it immediately to SQLite with status `QUEUED` before touching the network.*
  > 
  > *If the connection dies halfway through, we retry using the exact same `client_report_id`. Because `mock-server.js` checks idempotency before injecting any failures, it returns an HTTP `409 Conflict` carrying the original `report_id`. Our sync dispatcher treats `409` as a first-class success, extracts the ID, and marks the report confirmed. Zero duplicates are ever created."*

---

### [0:45 – 1:30] The Queue & Force-Quit Resilience
* **What to show on screen:** Open the running app on your phone/emulator and `src/storage/db.ts`.
* **What to say:**
  > *"Next, let's look at persistence and force-quit survival. We use `expo-sqlite` with Write-Ahead Logging (WAL mode) rather than `AsyncStorage`, because SQLite gives us atomic ACID transactions that survive sudden OS kills.*
  > 
  > *Notice lines 35–40 in `src/storage/db.ts`: if the Android Low Memory Killer terminates the app while a request is in-flight, our database bootstrap executes an atomic recovery query that resets `IN_FLIGHT` back to `QUEUED`.*
  > 
  > *Let's demonstrate this live: I'll toggle 'Force Offline' in the app. Now I'll submit 3 reports. You can see all 3 entries immediately appear in the Outbox as `QUEUED`. Now I'll swipe-kill the app completely from the OS app switcher, reopen it, and as you can see, all 3 reports are still here in SQLite, ready to dispatch."*

---

### [1:30 – 2:20] Live Sync against Hostile Server Chaos
* **What to show on screen:** Turn offline mode off in the app, and open the "Live Log" drawer on screen, showing real-time sync logs.
* **What to say:**
  > *"Now let's turn the network back on. Our dispatcher acquires a serial mutex lock and starts dispatching.*
  > 
  > *Look at the Live Dispatcher Stream: report #1 succeeds with `201 Created`. Report #2 hits a socket hangup from `save_then_drop`. Our dispatcher catches the drop, applies exponential backoff with full jitter, and re-submits.*
  > 
  > *Notice the next line in the log: `HTTP 409 Conflict resolved: report was already stored as srv_xxxx`. It immediately transitions to `CONFIRMED`. Notice also how `429 Too Many Requests` is handled by honoring the `Retry-After` header."*

---

### [2:20 – 3:00] Verification & Weakest Points
* **What to show on screen:** Tap "Check Mock Server Stats" in the app (or run `npm run test:sync` in the terminal), then switch to the README.
* **What to say:**
  > *"Let's tap 'Check Mock Server Stats'. The mock server responds directly: `VERDICT: PASS — no duplicates`, with `reports_stored: 3` and `duplicates_created: 0`.*
  > 
  > *Finally, per the brief, what in my solution am I least confident about?*
  > 1. *Server-side memory: the mock server keeps its idempotency map in process memory. If the backend process restarted during a dropped connection, its memory would be wiped.*
  > 2. *Aggressive Android OEM battery killers: low-end Androids like Infinix or Xiaomi kill background timers. In production, we would use an Android Foreground Service or WorkManager to drain the outbox even when the screen is locked.*
  > 
  > *Thank you, and looking forward to your thoughts!"*
