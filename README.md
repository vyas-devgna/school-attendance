# School Attendance System

Daily-use attendance for one small Gujarat school. One Windows PC stores the authoritative
JSON database; installable Admin and Teacher PWAs run locally or from GitHub Pages.

## Start

```powershell
cd server
npm install
npm start
```

- Local admin: http://localhost:3000/admin/
- Local teacher app: http://localhost:3000/app/
- Remote admin: https://vyas-devgna.github.io/school-attendance/admin/
- Remote teacher: https://vyas-devgna.github.io/school-attendance/app/

On first use, open the local admin URL on the office PC and complete setup. Do not run
`npm run seed` on a live school database; it replaces `server/db.json` with demo data.

## Pairing

1. Open local Admin > Pair Device.
2. Select the admin or teacher.
3. Scan the QR or enter the six-digit code in the installed PWA.
4. QR and code resolve the same 15-minute, one-time invite.
5. First pairing and later requests try WebRTC through `/signal`; HTTPS REST through the
   public tunnel is the fallback.

The server requests the stable public URL `https://vyas-school-att.loca.lt`. Check Admin >
Diagnostics before pairing remote devices. If that URL is unavailable, QR pairing can use the
temporary URL shown by Diagnostics, but six-digit remote pairing requires the stable URL.

## Data Safety

- Attendance saves to the device first, then retries sync.
- Each save has stable operation IDs; duplicate sync is ignored.
- Conflicting devices and locked edits create admin correction requests instead of overwriting.
- Database writes use temp-file + rename.
- Start-up and daily backups are kept locally (latest 30).
- A corrupt database is quarantined and restored from the newest valid backup.
- `server/db.json`, backups, and device tokens are never committed.

## Tests

```powershell
cd server
npm test
npm audit --omit=dev
```

`npm test` covers local-only setup, QR/code enrollment, role mismatch, assignment permissions,
device-token authentication/revocation, duplicate sync, conflict/correction flow, DB recovery,
and the WebRTC DataChannel bridge.

## Deploy GitHub Pages

```powershell
node scripts/sync-docs.mjs
git add -A
git commit -m "deploy: attendance 2.1.0"
git push origin pairing-webrtc-rebuild:master
gh api repos/vyas-devgna/school-attendance/pages
```

Pages must use branch `master`, folder `/docs`. Never edit `docs/` by hand.

## Daily Use

Admin: start the server, confirm Remote access is Ready, review classes not marked, corrections,
sync failures, and backup status.

Teacher: open the installed app, confirm the class/date, mark attendance, tap Save, and wait for
Saved then Synced. If offline, the app keeps the pending count and retries.

## Recovery

- Pairing/QR/code failure: generate a new invite; codes expire and are one-time.
- Server off: attendance remains on the device; restart `npm start`.
- Remote access off: local/LAN use continues; restart the server and check Diagnostics.
- Device removed: generate a new invite or restore it from Admin > Devices.
- Browser data cleared: pair again.
- Stale app: close/reopen the installed PWA; if needed remove and reinstall it.
- Restore: Admin > Backup > Restore; the server creates a pre-restore backup first.

## Limits

Free WebRTC without a TURN server cannot cross every NAT; HTTPS tunnel fallback is required.
Localtunnel is free and best-effort, not an availability guarantee. For dependable off-site
access, configure a named Cloudflare Tunnel and update `ATT.PUBLIC_SERVER` in
`shared/config.js`; no cloud database is required.
