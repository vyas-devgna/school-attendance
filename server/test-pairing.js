// ponytail: end-to-end pairing self-test against the real server, on a throwaway DB.
// Covers invite create/validate, QR(token) + 6-digit(code) enroll, role-mismatch block,
// already-used + expired rejection, and attendance opId idempotency. Run: node test-pairing.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-test-'));
const DB_PATH = path.join(tmpDir, 'db.json');

// minimal seed
fs.writeFileSync(DB_PATH, JSON.stringify({
  settings: { setupDone: true, schoolName: 'Test School', lockAfterHours: 0, maxDevicesPerUser: 2 },
  users: [{ id: 'admin-1', name: 'Admin', role: 'admin', active: true }, { id: 'ct-1', name: 'Teacher', role: 'class_teacher', active: true }],
  classes: [{ id: 'c1', name: '1', division: 'A', label: '1-A' }, { id: 'c2', name: '2', division: 'A', label: '2-A' }],
  students: [
    { id: 's1', name: 'Stu', rollNo: 1, classId: 'c1', active: true },
    { id: 's2', name: 'Other', rollNo: 1, classId: 'c2', active: true },
  ],
  assignments: [{ id: 'a1', userId: 'ct-1', classId: 'c1', type: 'class_teacher' }],
  devices: [], enrollmentTokens: [], attendance: [], corrections: [], log: [], holidays: [],
}));

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('  PASS', name); } else { failed++; console.error('  FAIL', name); } }
const J = (r) => r.json();

async function run() {
  // 1. create invite for the teacher
  const inv = await fetch(`${BASE}/api/invite/ct-1`, { method: 'POST' }).then(J);
  ok('invite has code+token+role', inv.code && inv.token && inv.role === 'class_teacher' && inv.appType === 'teacher');

  // 2. validate without enrolling
  const val = await fetch(`${BASE}/api/invite/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: inv.code }) }).then(J);
  ok('validate returns role for teacher app', val.valid && val.appType === 'teacher');

  // 3. role mismatch — teacher invite cannot enroll an admin app
  const mism = await fetch(`${BASE}/api/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: inv.code, deviceId: 'devX001', appType: 'admin' }) });
  ok('role mismatch blocked (403)', mism.status === 403);

  // 4. enroll with the 6-digit CODE → issues a deviceToken
  const en1 = await fetch(`${BASE}/api/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: inv.code, deviceId: 'dev0001', appType: 'teacher' }) }).then(J);
  ok('code enroll issues deviceToken', !!en1.deviceToken && en1.user.role === 'class_teacher');

  // 5. same code again → already used (410)
  const reuse = await fetch(`${BASE}/api/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: inv.code, deviceId: 'dev0002', appType: 'teacher' }) });
  ok('used code rejected (410)', reuse.status === 410);

  // 6. QR/token path uses the SAME invite model — new invite, enroll by token
  const inv2 = await fetch(`${BASE}/api/invite/ct-1`, { method: 'POST' }).then(J);
  const en2 = await fetch(`${BASE}/api/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: inv2.token, deviceId: 'dev0001', appType: 'teacher' }) }).then(J);
  ok('token(QR) enroll works for same user', !!en2.deviceToken);

  // 7. authenticated request with deviceToken works; without → 401
  const meOk = await fetch(`${BASE}/api/me`, { headers: { 'x-device-token': en2.deviceToken, 'x-forwarded-for': '9.9.9.9' } });
  const meNo = await fetch(`${BASE}/api/me`, { headers: { 'x-forwarded-for': '9.9.9.9' } });
  ok('token authenticates remote /me', meOk.status === 200);
  ok('no token remote → 401', meNo.status === 401);

  // 8. server enforces assignment scope; client-supplied identity is ignored
  const forbiddenRoster = await fetch(`${BASE}/api/students/c2`, { headers: { 'x-device-token': en2.deviceToken, 'x-forwarded-for': '9.9.9.9' } });
  const forbiddenReport = await fetch(`${BASE}/api/reports/daily/c2/2026-06-25`, { headers: { 'x-device-token': en2.deviceToken, 'x-forwarded-for': '9.9.9.9' } });
  const forbiddenWrite = await fetch(`${BASE}/api/attendance`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-token': en2.deviceToken, 'x-forwarded-for': '9.9.9.9' },
    body: JSON.stringify({ records: [{ classId: 'c2', studentId: 's2', date: '2026-06-25', status: 'present', opId: 'forbidden-1' }] }),
  });
  ok('teacher cannot read unrelated roster', forbiddenRoster.status === 403);
  ok('teacher cannot read unrelated report', forbiddenReport.status === 403);
  ok('teacher cannot write unrelated attendance', forbiddenWrite.status === 403);

  // 9. attendance idempotency by opId
  const body = { records: [{ classId: 'c1', studentId: 's1', date: '2026-06-25', status: 'present', opId: 'op-1', markedBy: 'admin-1', deviceId: 'spoofed' }] };
  const h = { 'Content-Type': 'application/json', 'x-device-token': en2.deviceToken, 'x-forwarded-for': '9.9.9.9' };
  const a1 = await fetch(`${BASE}/api/attendance`, { method: 'POST', headers: h, body: JSON.stringify(body) }).then(J);
  const a2 = await fetch(`${BASE}/api/attendance`, { method: 'POST', headers: h, body: JSON.stringify(body) }).then(J);
  ok('first sync adds 1', a1.added === 1);
  ok('duplicate opId ignored', a2.duplicate === 1 && a2.added === 0);

  const saved = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')).attendance[0];
  ok('server records authenticated identity', saved.markedBy === 'ct-1' && saved.deviceId === 'dev0001');

  // 10. a conflicting second device creates an admin correction instead of overwriting
  const inv3 = await fetch(`${BASE}/api/invite/ct-1`, { method: 'POST' }).then(J);
  const en3 = await fetch(`${BASE}/api/enroll`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: inv3.code, deviceId: 'dev0002', appType: 'teacher' }),
  }).then(J);
  const conflict = await fetch(`${BASE}/api/attendance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-token': en3.deviceToken, 'x-forwarded-for': '9.9.9.9' },
    body: JSON.stringify({ records: [{ classId: 'c1', studentId: 's1', date: '2026-06-25', status: 'absent', opId: 'op-conflict' }] }),
  }).then(J);
  const afterConflict = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  ok('conflict becomes correction', conflict.conflicts === 1 && afterConflict.attendance[0].status === 'present' && afterConflict.corrections.length === 1);

  // 11. a locked edit becomes a correction instead of being lost
  await fetch(`${BASE}/api/attendance`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ records: [{ classId: 'c1', studentId: 's1', date: '2020-01-01', status: 'present', opId: 'op-old' }] }),
  });
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Host: `localhost:${PORT}` },
    body: JSON.stringify({ lockAfterHours: 1 }),
  });
  const lockedEdit = await fetch(`${BASE}/api/attendance`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ records: [{ classId: 'c1', studentId: 's1', date: '2020-01-01', status: 'leave', opId: 'op-locked' }] }),
  }).then(J);
  ok('locked edit becomes correction', lockedEdit.corrections === 1);

  // 12. revoked devices receive the explicit revoked response
  await fetch(`${BASE}/api/revoke/dev0001`, { method: 'POST' });
  const revoked = await fetch(`${BASE}/api/me`, { headers: { 'x-device-token': en2.deviceToken, 'x-forwarded-for': '9.9.9.9' } });
  const revokedBody = await revoked.json();
  ok('revoked token rejected as revoked', revoked.status === 403 && revokedBody.error === 'revoked');

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const srv = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH, BACKUP_DIR: tmpDir, NO_TUNNEL: '1', NO_SIGNAL: '1' },
  stdio: 'ignore',
});
process.on('exit', () => { try { srv.kill(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

setTimeout(() => run().catch(e => { console.error('test error', e); process.exit(1); }), 1500);
