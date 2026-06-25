# School Attendance Prototype

Proves: QR enrollment → persistent pairing → auto-reconnect → role-based attendance.

## Quick Start

```bash
cd server
npm install
npm run seed    # creates db.json with demo data
npm start       # starts on http://localhost:3000
```

Admin panel: http://localhost:3000/admin

## Demo Data (after seed)

| User | Role | Assigned |
|---|---|---|
| Admin | admin | — |
| Mrs. Sharma | class_teacher | Class 5-A |
| Mr. Patel | class_teacher | Class 5-B |
| Ms. Mehta | subject_teacher | (assign via admin) |

Classes: **Class 5-A** (10 students), **Class 5-B** (10 students)

## How to Test

### 1. Start the server
```bash
cd server && npm start
```

### 2. Open admin
Open http://localhost:3000/admin in your browser.

### 3. Enroll a teacher
1. In admin → **Users** tab → click **QR** button next to a teacher
2. A QR code appears
3. Open the PWA at `http://localhost:3000/../app/index.html` (or serve `app/` separately)
4. Click **Scan QR Code** or use **Enter Code Manually**
5. The app enrolls and shows the attendance screen

### 4. Test persistence
- Refresh the page → still paired
- Close and reopen browser → still paired
- The app calls `/api/me` on every open to verify

### 5. Mark attendance
- Select date → toggle present/absent per student → Save
- Data saves locally first, then syncs to server

### 6. Test offline
- Stop the server → open the app → mark attendance → saves locally
- Start the server → app syncs automatically within 30s

### 7. Revoke a device
- Admin → **Devices** tab → click **Revoke**
- Teacher app shows "Device revoked" on next connection check

### 8. Subject teacher
- Admin → **Assign** tab → select Ms. Mehta → pick class + date → **Allow**
- Generate QR for Ms. Mehta → scan from another browser/tab
- Subject teacher sees only the allowed class, date is locked

## Deploy to GitHub Pages

We use the `docs/` folder for hosting both the Admin PWA and the Teacher PWA on GitHub Pages:
1. Push the repository to GitHub.
2. Go to repo **Settings** → **Pages** → under "Build and deployment", set source to "Deploy from a branch" and select `/docs` folder.
3. The Admin PWA will be available at `https://<username>.github.io/<repo>/admin/` and the Teacher PWA at `https://<username>.github.io/<repo>/app/`.
4. Devices scan QR codes or enter 6-digit codes pointing to the local server (`http://<LAN-IP>:3000`). Once paired, they communicate directly with the local server over the local network.

> **Note**: The PWA needs the local server for enrollment and sync. It works offline after enrollment but needs the server to sync data.

## Configuring Server URL for Mobile

When teachers are on the same network:
- Find your PC's LAN IP (shown in server startup output)
- The QR code automatically embeds `http://<LAN-IP>:3000`
- Teachers' phones must be on the same WiFi network

## Structure

```
att/
├── server/
│   ├── index.js       # Express server, all endpoints
│   ├── seed.js        # Demo data generator
│   ├── db.json        # JSON "database" (auto-generated)
│   └── package.json
├── admin/
│   └── index.html     # Admin panel (served by Express)
├── app/
│   ├── index.html     # PWA single page
│   ├── style.css      # Dark theme, responsive
│   ├── app.js         # All client logic
│   ├── manifest.json  # PWA manifest
│   └── sw.js          # Service worker
├── docs/
│   ├── admin/         # Copy of admin/ for GitHub Pages
│   └── app/           # Copy of app/ for GitHub Pages
└── README.md
```

## Test Checklist

- [ ] Admin PWA and Teacher PWA install gates function correctly in normal browser
- [ ] Admin creates user and generates pairing QR code & 6-digit code
- [ ] Teacher app scans QR or enters code manually → enrolls device
- [ ] Pairing persists after page refresh/closing browser
- [ ] Class teacher sees only assigned class
- [ ] Subject teacher blocked from marking if date is not permitted by assignment
- [ ] Mark attendance: Present (P), Absent (A), Late (L), Leave (V) with optional notes
- [ ] Attendance lock: edit disabled if older than lock period (e.g. 24 hours)
- [ ] Correction request: teacher submits correction request on locked records (also works offline & syncs)
- [ ] Admin corrections review: approves or rejects requests in the admin panel
- [ ] Reports: Class summary, daily stats, weekly Mon-Sun grid, and monthly reports
- [ ] Backup: manual backup download, restore from JSON file, and auto daily backups
- [ ] Device revocation: admin revokes device, teacher app locks on next check
- [ ] Offline operation: marking and corrections queue locally and auto-sync when online

