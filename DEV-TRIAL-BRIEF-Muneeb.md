# Trial task — offline-first field reporting

**One day.**
Use AI tools freely — we do. We would rather see how you actually work than watch you avoid them.

We run field teams across Pakistan. They work in markets and outlets on low-end Android phones, on
connections that drop constantly. Everything we build for them has to assume the network is not there.

This is a deliberately small version of that problem. There is no trick in it. It is one screen, and
almost all of the work is in one thing: **making sure a report is never sent twice.**

---

## What to build

A **React Native (Expo)** screen that lets a field worker submit a report:

- **outlet name**
- **what they found**
- **action needed**
- the device's **GPS coordinates** (if location permissions fight you, hardcode a lat/lng and say so in
  the README — we are not testing `expo-location`)

Submit sends it to the mock API you have been given.

### The part that matters

**It has to work with no connectivity.**

- Submissions queue locally when there is no network.
- The queue survives the app being **killed and reopened** — force-quit, not just backgrounded.
- It syncs when the network returns.
- **The same report must never be stored twice on the server**, no matter what the network does.
- The user can always see the state of their queue, and can tell what has actually been sent.

**Not needed, deliberately:** no photo, no login, no list of past reports, no design work. One screen.

---

## The mock server

`mock-server.js` is included. Node 18+, no dependencies.

```
node mock-server.js
```

**Do not modify this file.** It is how the work is assessed and every candidate gets the same one. It
prints a hash of its own source on startup; if that hash changes, we know it was edited.

**It is deliberately hostile, and the pattern is the same every run:**

- roughly **6 in 10 requests fail**
- **2 in every 10 save your report and then kill the connection before answering.** You get a network
  error for a report the server already has. **This is the case the whole task is about.**
- responses take between about 1 and 6 seconds
- to test true offline, put the phone in airplane mode — do not simulate it in the server

### How it is checked

```
GET /v1/_debug/count
```

Returns, among other things:

```jsonc
{ "VERDICT": "PASS — no duplicates", "reports_stored": 3, "duplicates_created": 0 }
```

We submit a known number of reports through your app while the network is failing, then open that URL.
**`duplicates_created` must be 0.** Nothing else can make up for it if it isn't.

`POST /v1/_debug/reset` clears the server between your own test runs.

---

## What to hand back

1. **The code**, in a git repo we can clone (GitHub, public or private).
2. **A short README** — how to run it, and **what in your solution you are least confident about.**
3. **A screen recording, about 3 minutes**, walking through your own code — the queue, and what happens
   when a send fails. Phone recording or Loom, quality does not matter. Talk over it.

The last two are not formalities. We would rather work with someone who can name the weak part of his own
work than someone who says there isn't one — and three minutes of you explaining your own queue tells us
more than an hour of reading it.

---

## What we are actually looking at

So you are not guessing:

- Whether the same report can end up on the server twice, and how you stopped it.
- What happens when a send dies halfway.
- Whether the user is ever told something was sent when it wasn't.
- Whether the queue really survives a force-quit.
- Your commit log.

**We are not looking at visual design.** A plain screen that never double-submits beats a beautiful one
that does.

---

# Appendix — API contract

Base URL `http://localhost:4000` by default (`PORT=5000 node mock-server.js` to change it).
JSON in, JSON out.

### `POST /v1/reports`

```jsonc
{
  "client_report_id": "string, optional",   // see the note below
  "outlet_name":      "string, required",
  "finding":          "string, required",
  "action_needed":    "string, required",
  "captured_at":      "ISO-8601, required",  // when the worker filled the form
  "lat":              24.8607,               // number, required
  "lng":              67.0011                // number, required
}
```

```jsonc
// 201 Created
{ "report_id": "srv_8f2c…", "received_at": "2026-09-09T12:04:11Z" }
```

| Status | Meaning | What to do |
|---|---|---|
| `400` | required field missing or malformed | do not retry — it will never succeed |
| `409` | a report with this `client_report_id` already exists | body carries the original `report_id` |
| `429` | rate limited | honour the `Retry-After` header, in seconds |
| `500` `502` `503` | server-side failure | safe to retry |
| *connection dies / no response* | **the server may or may not have saved it** | your call — this is the interesting one |

**Note on `client_report_id`:** the field is optional. If you supply it, the server guarantees it will not
store a second report with the same value — a repeat returns `409` with the original `report_id`.

### `GET /v1/reports/{report_id}`

```jsonc
// 200
{ "report_id": "srv_8f2c…", "outlet_name": "…", "received_at": "…" }
// 404 if it does not exist
```

---

**Ask questions while you build.** A good question about the contract is a better signal than a quiet
guess, and we would much rather answer one now than see you hand back the wrong thing.
