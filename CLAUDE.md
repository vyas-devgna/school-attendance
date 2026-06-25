# CLAUDE.md — School Attendance System

Guidance for future work on this repo. Read before changing pairing, transport, or deploy.

## What this is
A daily-use attendance app for one small Gujarat school (~25 staff, ~4000 students). One
Windows PC runs the Node server (authoritative flat-file DB). Admin + Teacher PWAs are static,
hosted on GitHub Pages, and talk to that PC. No cloud DB, no Firebase, no SaaS.

## Architecture
```
server/index.js   Express API + JSON-file DB + invites/auth + signalling mount (NO tunnel)
server/signal.js  Real PeerJS library (Node) on node-datachannel polyfill; ONE stable peer id
                  on the free 0.peerjs.com broker; DataConnection ⇄ loopback HTTP to routes
shared/           ONE client core, used by BOTH apps (no drift):
  config.js         version, SERVER_PEER_ID (must match server PEER_ID), STUN+free TURN, genId
  connection.js     transport: same-origin REST on the PC, else WebRTC P2P via PeerJS; timeouts
  pairing.js        enroll()/reconnect()/parseQR() — QR and 6-digit use the SAME path
  vendor/lucide.min.js, vendor/peerjs.min.js   served locally (no CDN)
admin/index.html  admin panel (inline JS)
app/              teacher PWA (index.html, app.js, style.css, sw.js)
docs/             GENERATED copy of admin/ app/ shared/ for GitHub Pages — run the sync, don't hand-edit
```

## Run
```
cd server
npm install        # express, cors, qrcode, ws, node-datachannel, peerjs
npm run seed       # demo db.json (optional; first-run wizard can also set up)
npm start          # http://localhost:3000  (admin: /admin, app: /app)
```
On start the PC registers ONE stable peer id (`PEER_ID`, default `att-vyasdevgna-school-9k4f2`)
on the free PeerJS broker so remote devices can reach it over WebRTC. No tunnel, no port-forward.
Env knobs: `PORT`, `PEER_ID` (must match `SERVER_PEER_ID` in shared/config.js), `NO_SIGNAL=1`
(skip broker, offline/dev), `DB_PATH`/`BACKUP_DIR` (tests), `TURN_URL`/`TURN_USER`/`TURN_PASS` (extra TURN).

## Test
```
cd server
npm test               # setup, pairing/auth/permissions/conflicts, DB recovery, WebRTC
npm audit --omit=dev   # must report zero vulnerabilities
```
Browser: `npm start`, open `/admin` on the PC (trusted local, no pairing). For remote/pairing,
use the Pages URLs or a second origin. WebRTC interop is validated in Chromium.

## Deploy (GitHub Pages, source = /docs)
```
node scripts/sync-docs.mjs   # copies admin/ app/ shared/ → docs/  (edge 111)
git add -A && git commit -m "deploy" && git push
```
Then confirm Pages source with `gh api repos/vyas-devgna/school-attendance/pages`.
- Admin:   https://vyas-devgna.github.io/school-attendance/admin/
- Teacher: https://vyas-devgna.github.io/school-attendance/app/
ALWAYS bump the cache name in `app/sw.js` + `admin/sw.js` on any client change,
or installed apps keep old code. Never copy `server/db.json` or `server/backups/` into `docs/`.

## Pairing architecture (the core)
- Admin makes an invite per user → server stores it (15-min expiry, one-time, role+appType).
- QR encodes `{server, token, code, role, appType}`; the 6-digit code resolves to the SAME invite.
- A remote app opens a WebRTC DataConnection to the PC's stable peer id (via the free PeerJS
  broker + STUN/TURN) and sends `enroll`. If it can't connect, data stays in the offline queue —
  there is no public HTTP fallback (no tunnel). On the PC itself, same-origin REST is used.
- Server issues a per-device `deviceToken`; the client sends it as `token` in each framed request
  (and as `x-device-token` on the PC). The gate enforces token → device(active,!revoked) → user → role.
- Only a browser on the PC itself (localhost, no XFF, no bridge marker) is trusted as local admin.

## Lessons already paid for
- ntfy polling/cache behavior was unreliable; do not restore it.
- QR and six-digit code must resolve the same stored invite.
- GitHub Pages cannot call a private local HTTP server without a reachable HTTPS path.
- Plain local HTTP needs an ID fallback when `crypto.randomUUID` is unavailable.
- Service workers can preserve broken clients; bump both cache names for every client release.
- Admin and teacher pairing/transport stay in `shared/`; never fork the implementation.

## Backup / data safety
- `saveDb()` is atomic (temp + rename, JSON-validated). Backups on start + daily, kept ×30.
- Restore makes a pre-restore backup and validates the file first. Disable/archive, never hard-delete.
- `server/db.json` + `server/backups/` are gitignored — never commit real student data.

## UI rules
Plain words, no jargon (no IP/CORS/tunnel/WebRTC on normal screens). Mobile-first, large touch
targets, one obvious primary action, sync/server status always visible, clear empty/error/success
states, confirm before destructive actions. Don't add decorative motion or heavy theming.

## Honest limitations
- Remote access needs (a) the office PC on with internet, (b) the free PeerJS broker (0.peerjs.com)
  reachable, and (c) WebRTC able to connect (STUN, or free TURN for hard NATs). The bundled free
  TURN (OpenRelay) covers most networks; if it's ever down, very strict NATs may not connect. When
  any of these fail, the app keeps working offline and queues attendance — it never loses data.
- The stable peer id is public on the shared broker. If a third party squats it, change `PEER_ID`
  (server) and `SERVER_PEER_ID` (config.js) to a new value and redeploy.
- GitHub Pages (HTTPS) can't reach a plain `http://LAN` server, so remote = WebRTC only; on the
  office PC itself, the apps use same-origin REST directly.

## Do NOT add
Cloud DB / Firebase / Supabase / SaaS; payments; SMS/WhatsApp; biometrics/face; a JS framework
(React/Vue/Next) or build step; new heavy deps. Keep it small, recoverable, and offline-first.
```
