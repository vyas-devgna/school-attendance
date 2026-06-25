# Pairing Diagnosis Report

Date: 2026-06-25
Branch: `pairing-webrtc-rebuild`
Method: full source read of every file + live server boot (`node index.js`) on Node v26.2.0.

This is the non-negotiable first deliverable. It documents *why* pairing fails before any
repair. Each root cause names the exact file, line, function, and the failure mechanism.

---

## 1. Summary

The system has **two pairing entry points (QR and 6-digit code) that resolve differently**,
a **public server URL that changes on every restart**, and a **remote-admin form that is
structurally impossible over HTTPS**. Local (on-server) pairing works; remote pairing
(GitHub Pages, off-LAN) is broken. There is also effectively **no authentication** on the API
and **real student data is committed to a public repo**.

Confidence: items 1–10 are **code-certain** (provable from the source). Items marked
*(browser-confirmed needed)* describe a browser-policy outcome that follows necessarily from
the code but would additionally show in a live device test.

---

## 2. Root causes

### RC-1 — Teacher 6-digit pairing has no server address (P0)
`app/app.js` → `manualEnroll()` (line 214):
```js
const server = window.location.origin;
const res = await fetch(server + '/api/enroll', …)
```
The teacher pairing screen (`app/index.html` lines 56–62) has **only** a 6-digit field — no
server field. When the PWA is served from GitHub Pages, `window.location.origin` is
`https://vyas-devgna.github.io`, so it POSTs to `https://vyas-devgna.github.io/api/enroll`,
which does not exist → **6-digit teacher pairing is impossible for any remote user.** It only
works when the app is served by the local server (localhost / LAN), where origin happens to be
the server.

### RC-2 — QR and 6-digit code carry different information (P0)
The QR payload is `JSON.stringify({ server: serverUrl, token })`
(`server/index.js` line 347). The 6-digit code is six bare digits with **no server**. So the QR
path *can* reach the server (it embeds the URL) while the code path cannot. This is the reported
"QR and code fail differently" — it is structural, not a bug in one branch.

### RC-3 — Public tunnel URL is randomized every restart (P0)
`server/index.js` line 806:
```js
const tunnel = await localtunnel({ port: PORT, subdomain: 'vyas-school-att-' + Math.floor(Math.random()*10000) });
```
Every server start requests a **different** subdomain, so the public HTTPS URL changes on each
restart. Consequences:
- Every previously printed QR (which embedded the old URL) is dead.
- Every device's saved `pairing.server` points at a dead URL → silent reconnect failure.
- There is **no endpoint-refresh path** and **no endpoint that even exposes the current URL**
  to a client (confirmed: no `/api/server-info`). edges 30, 37, 114.

### RC-4 — Remote admin form is impossible over HTTPS (P0)
`admin/index.html` line 95 placeholder `http://192.168.1.6:3000`; `adminPair()` (line 329)
fetches whatever the admin types. Two failures, both *(browser-confirmed needed)* but forced by
policy:
- A LAN address requires being on the school Wi-Fi — violates the remote-admin requirement.
- A page served over **HTTPS** (GitHub Pages) making a request to **`http://`** (the LAN server)
  is **blocked by the browser's mixed-content policy** — the fetch never leaves the page, and the
  current code shows only a generic failure. The admin literally cannot type any working address
  unless it is the HTTPS tunnel URL, which they have no way to discover. edges 26, 27.

### RC-5 — Service workers never ship updates (P1)
`app/sw.js` (`CACHE = 'att-v2'`) and `admin/sw.js` (`CACHE = 'admin-v1'`) are cache-first for the
app shell with a **fixed** cache name and no update prompt. Once installed, a device keeps
serving the **old** `app.js` / `index.html` even after we fix them, until the cache name changes.
Any fix we ship is invisible to already-installed devices. edges 18, 57, 112.

### RC-6 — UI depends on an uncached external CDN (P1)
`admin/index.html` line 11 and `app/index.html` line 13 load
`https://unpkg.com/lucide@latest`. The service worker does **not** cache it (cross-origin, not in
`SHELL`). Offline, or if unpkg is slow/down, `lucide` is undefined and every
`lucide.createIcons()` call throws → blank / broken admin. This is the reported "GitHub Pages
admin network dependency". edges 99, 100.

### RC-7 — No detection of the localtunnel interstitial / non-JSON (P1)
localtunnel serves an HTML "click to continue" reminder page. The clients send the
`Bypass-Tunnel-Reminder` header (good) but **never check** that the response is JSON. When the
warning page (or any HTML error) comes back, `res.json()` throws an opaque
`SyntaxError: Unexpected token <` with no user guidance. edges 21, 31.

### RC-8 — The API is effectively unauthenticated (P0 security)
Almost every endpoint in `server/index.js` is open. `/api/users`, `/api/students`,
`/api/assignments`, `/api/settings`, backup download, etc. require **no token**. Only
`/api/me` and `/api/my-assignments` check `x-device-id`, and a device id is **not a secret** (it
is generated client-side and sent in clear). Once the tunnel URL is known, anyone can read all
student data and mutate the database. edges 105, 106, 107, 108.

### RC-9 — Invite/enroll weaknesses
`server/index.js` `/api/enroll` (lines 352–373):
- An **already-used 6-digit code** returns `404 "Invalid or expired code"` instead of
  `410 "already used"` (the `&& !t.used` filter hides it), so the user sees the wrong message.
  edge 9.
- Tokens **never expire** — `expiresNote: 'One-time use'` is cosmetic; there is no time check.
  edges 5, 6.
- Role / app-type are checked **only on the client** (`result.user.role !== 'admin'`); the server
  will enroll any device against any invite. edges 10–13.

### RC-10 — Privacy + crash hygiene
- 1211 `node_modules` files **and** `server/db.json` + `server/backups/*` (real student names and
  attendance) were committed to the **public** repo; there was no `.gitignore`. edges 109, 110.
  (Fixed in Phase 0.)
- Live boot reproduced edge 116: starting a second instance throws an **unhandled**
  `EADDRINUSE` and crashes instead of a friendly message.

---

## 3. What works today (keep — do not rebuild)

- All CRUD / reports / backup / corrections endpoints function (verified `/api/ping`,
  `/api/settings` returning seeded "Sunrise School, Anand").
- Teacher offline-first local-save + 30s sync queue (`app/app.js` `saveAttendance` / `syncPending`).
- Local admin works same-origin and bypasses the install gate on `localhost`
  (`admin/index.html` `isLocalHost`).
- `genId()` crypto-with-fallback exists in both clients (edge 19 already handled).

---

## 4. Repair plan (implemented in later phases)

1. **Stabilize the public endpoint** — fixed localtunnel subdomain + an endpoint-refresh path +
   `/api/server-info` exposing the current URL, fingerprint, version. (RC-3)
2. **One invite model, one client pairing path** — QR and 6-digit resolve to the **same**
   server-validated invite (expiry, one-time, role, app-type). No client carries a server address
   the user must type. (RC-1, RC-2, RC-4, RC-9)
3. **WebRTC transport** (per requirement) — first pairing and all sync over a DataChannel
   established through signalling on the local server (exposed via the stable tunnel); REST over
   the tunnel as automatic fallback; offline queue last. Honest about NAT/TURN limits. (RC-1, RC-4)
4. **deviceToken auth** — pairing issues a per-device secret ("connection key"); both transports
   authenticate with it; server middleware enforces token → device → user → role. (RC-8)
5. **Service-worker versioning + vendored lucide + update prompt.** (RC-5, RC-6)
6. **Non-JSON / tunnel-warning detection + timeouts + plain messages** in the transport. (RC-7)
7. **Graceful port-in-use and JSON-only API errors.** (edge 116)
