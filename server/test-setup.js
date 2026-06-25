// ponytail: setup is an office-PC-only action, even before the first admin exists.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-setup-test-'));
const dbPath = path.join(tmpDir, 'db.json');
const srv = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, BACKUP_DIR: tmpDir, NO_TUNNEL: '1', NO_SIGNAL: '1' },
  stdio: 'ignore',
});

function done(code) {
  process.exitCode = code;
  try { srv.kill(); } catch {}
  srv.once('exit', () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
}

setTimeout(async () => {
  try {
    const body = JSON.stringify({ schoolName: 'Test School', adminName: 'Admin' });
    const remote = await fetch(`${BASE}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '9.9.9.9' },
      body,
    });
    const local = await fetch(`${BASE}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: `localhost:${PORT}` },
      body,
    });
    await Promise.all([remote.text(), local.text()]);
    if (remote.status !== 403 || local.status !== 200) throw new Error(`remote=${remote.status}, local=${local.status}`);
    console.log('PASS: first setup is blocked remotely and allowed on the office PC');
    done(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    done(1);
  }
}, 1200);
