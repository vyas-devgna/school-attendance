// ponytail: a partial/corrupt DB must recover from the newest valid local backup.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3996;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-recovery-test-'));
const backups = path.join(dir, 'backups');
const dbPath = path.join(dir, 'db.json');
fs.mkdirSync(backups);
fs.writeFileSync(dbPath, '{"broken":');
fs.writeFileSync(path.join(backups, 'backup-2026-06-25T01-00-00.json'), JSON.stringify({
  settings: { setupDone: true, schoolName: 'Recovered School' },
  users: [], classes: [], students: [], assignments: [], devices: [], enrollmentTokens: [],
  attendance: [], corrections: [], log: [], holidays: [],
}));

const srv = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, BACKUP_DIR: backups, NO_TUNNEL: '1', NO_SIGNAL: '1' },
  stdio: 'ignore',
});

function done(code) {
  process.exitCode = code;
  try { srv.kill(); } catch {}
  srv.once('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
}

setTimeout(async () => {
  try {
    const settings = await fetch(`http://127.0.0.1:${PORT}/api/settings`).then(r => r.json());
    const quarantined = fs.readdirSync(dir).some(name => name.startsWith('db.json.corrupt-'));
    if (settings.schoolName !== 'Recovered School' || !quarantined) throw new Error('backup was not restored');
    console.log('PASS: corrupt DB recovered from latest valid backup');
    done(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    done(1);
  }
}, 1200);
