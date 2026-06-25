// ponytail: entire server in one file — all endpoints, JSON-file storage, backup,
// invite/deviceToken auth, WebRTC signalling bridge, stable tunnel.
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const uuid = () => crypto.randomUUID();

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = '2.2.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json'); // override for tests
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const INVITE_TTL_MS = 15 * 60 * 1000; // ponytail: codes/QRs expire in 15 min (edges 5,6,101)
const TUNNEL_SUBDOMAIN = process.env.TUNNEL_SUBDOMAIN || 'vyas-devgna-att'; // stable (edge 3/30)
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) {
  ICE_SERVERS.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
}

app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id', 'x-device-token', 'Bypass-Tunnel-Reminder'],
}));
app.use(express.json({ limit: '10mb' }));
app.use('/api', apiGate); // central auth/role gate (hoisted below)

// --- DB helpers ---
function loadDb() {
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (error) {
    const quarantined = `${DB_PATH}.corrupt-${Date.now()}`;
    fs.renameSync(DB_PATH, quarantined);
    const backups = fs.existsSync(BACKUP_DIR)
      ? fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort().reverse()
      : [];
    for (const name of backups) {
      try {
        const json = fs.readFileSync(path.join(BACKUP_DIR, name), 'utf8');
        const recovered = JSON.parse(json);
        fs.writeFileSync(DB_PATH, json);
        console.error(`Database was damaged and recovered from ${name}. Damaged file kept as ${path.basename(quarantined)}.`);
        return recovered;
      } catch {}
    }
    throw new Error(`Database is damaged and no valid backup was found. Damaged file: ${quarantined}. ${error.message}`);
  }
}
function saveDb() {
  // ponytail: atomic write — temp file then rename, so a crash mid-write can't corrupt db.json
  const tmp = DB_PATH + '.tmp';
  const json = JSON.stringify(db, null, 2);
  JSON.parse(json); // guard: never persist something we can't read back
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, DB_PATH);
}
function addLog(action, userId, detail) {
  db.log.push({ id: uuid(), action, userId: userId || 'system', timestamp: new Date().toISOString(), detail: detail || '' });
  if (db.log.length > 5000) db.log = db.log.slice(-4000); // ponytail: cap log size
}

let db = loadDb();
ensureSchema();

// ponytail: guarantee server identity + all arrays exist (migration for older db.json)
function ensureSchema() {
  if (!db) return;
  db.settings = db.settings || { setupDone: false };
  if (!db.settings.serverId) db.settings.serverId = uuid();
  if (!db.settings.fingerprint) db.settings.fingerprint = crypto.randomBytes(8).toString('hex');
  for (const k of ['users', 'classes', 'students', 'assignments', 'devices', 'enrollmentTokens', 'attendance', 'corrections', 'log', 'holidays']) {
    if (!Array.isArray(db[k])) db[k] = [];
  }
}

// --- Backup helpers ---
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function createBackup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `backup-${ts}.json`;
  try {
    fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(db, null, 2));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    return name;
  } catch (e) {
    console.error('Backup failed:', e.message);
    return null;
  }
}

// ======== AUTH GATE ========
// Levels: public (no auth), user (any paired device or local PC), admin (admin device or local PC).
// First matching rule wins; default = admin. Paths here are WITHOUT the /api prefix.
const RULES = [
  ['GET', /^\/(health|ping|server-info)$/, 'public'],
  ['GET', /^\/diagnostics$/, 'admin'],
  ['POST', /^\/setup$/, 'public'],
  ['GET', /^\/settings$/, 'public'],
  ['POST', /^\/invite\/validate$/, 'public'],
  ['POST', /^\/enroll$/, 'public'],
  ['GET', /^\/students\/csv-sample$/, 'admin'],
  ['GET', /^\/me$/, 'user'],
  ['GET', /^\/my-assignments$/, 'user'],
  ['POST', /^\/attendance$/, 'user'],
  ['GET', /^\/attendance\//, 'user'],
  ['GET', /^\/attendance-summary\//, 'user'],
  ['GET', /^\/reports\/(daily|weekly|monthly|student|export)\//, 'user'],
  ['GET', /^\/students\/[^/]+$/, 'user'], // single class roster
  ['POST', /^\/corrections$/, 'user'],
  ['GET', /^\/holidays$/, 'user'],
];

function classify(method, p) {
  for (const [m, re, level] of RULES) {
    if (m === method && re.test(p)) return level;
  }
  return 'admin';
}

function isLocalTrusted(req) {
  // ponytail: trust ONLY a browser running on the PC itself. Tunnel requests carry
  // x-forwarded-for; WebRTC-bridged requests carry x-webrtc-bridge — neither is trusted.
  if (req.headers['x-webrtc-bridge']) return false;
  if (req.headers['x-forwarded-for']) return false;
  const ra = req.socket.remoteAddress || '';
  const loopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  const host = (req.headers.host || '').split(':')[0];
  return loopback && (host === 'localhost' || host === '127.0.0.1');
}

function apiGate(req, res, next) {
  const level = classify(req.method, req.path);
  const token = req.headers['x-device-token'];
  let device = null, user = null;
  if (token) {
    const hash = hashToken(token);
    device = db.devices.find(d => d.tokenHash === hash || d.token === token);
    if (device) {
      if (device.revoked) return res.status(403).json({ error: 'revoked' });
      if (!device.tokenHash) {
        device.tokenHash = hash;
        delete device.token;
        saveDb();
      }
      user = db.users.find(u => u.id === device.userId);
      if (!user || user.active === false) return res.status(403).json({ error: 'disabled' });
      device.lastSeen = new Date().toISOString();
    }
  }
  req.device = device;
  req.user = user;
  req.localTrusted = isLocalTrusted(req);

  if (level === 'public') return next();
  if (level === 'user') {
    if (user || req.localTrusted) return next();
    return res.status(401).json({ error: 'Not paired' });
  }
  // admin
  if (req.localTrusted) return next();
  if (user && user.role === 'admin') return next();
  if (!user) return res.status(401).json({ error: 'Not paired' });
  return res.status(403).json({ error: 'Admin only' });
}

// --- Serve static ---
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));
app.use('/app', express.static(path.join(__dirname, '..', 'app')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

// ======== HEALTH / SERVER INFO / DIAGNOSTICS ========

app.get('/api/ping', (_req, res) => res.json({ ok: true }));
app.get('/api/health', (_req, res) => res.json({ ok: true, version: APP_VERSION, uptime: Math.round(process.uptime()) }));

function serverInfo() {
  const isReady = !!(signalling && typeof signalling.isConnected === 'function' && signalling.isConnected());
  return {
    serverId: db.settings.serverId,
    fingerprint: db.settings.fingerprint,
    schoolName: db.settings.schoolName || null,
    setupDone: !!db.settings.setupDone,
    version: APP_VERSION,
    signalPath: '/signal',
    // ponytail: public info exposes only credential-less ICE (STUN). TURN creds are a secret
    // and are delivered only to authenticated devices via /api/me.
    iceServers: ICE_SERVERS.filter(s => !s.credential),
    endpoints: {
      public: isReady ? 'PeerJS P2P Active' : null,
      lan: `http://${getLanIp()}:${PORT}`,
      local: `http://localhost:${PORT}`,
    },
    tunnelStatus: isReady ? 'up' : 'down',
  };
}
app.get('/api/server-info', (_req, res) => res.json(serverInfo()));

app.get('/api/diagnostics', (_req, res) => {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort();
  const last = files.length ? files[files.length - 1] : null;
  res.json({
    server: serverInfo(),
    db: { ok: !!db, students: db.students.length, users: db.users.length, classes: db.classes.length, attendance: db.attendance.length },
    devices: { total: db.devices.length, active: db.devices.filter(d => !d.revoked).length, revoked: db.devices.filter(d => d.revoked).length },
    backup: { lastBackup: last ? fs.statSync(path.join(BACKUP_DIR, last)).mtime.toISOString() : null, backupCount: files.length },
    invites: { active: db.enrollmentTokens.filter(t => !t.used && Date.now() < new Date(t.expiresAt || 0).getTime()).length },
    tunnel: { status: (signalling && typeof signalling.isConnected === 'function' && signalling.isConnected()) ? 'up' : 'down', url: (signalling && typeof signalling.isConnected === 'function' && signalling.isConnected()) ? 'PeerJS P2P Active' : null, lastError: null },
    corrections: { pending: db.corrections.filter(c => c.status === 'pending').length },
  });
});

// ======== SETTINGS / SETUP ========

app.get('/api/settings', (_req, res) => {
  if (!db) return res.json({ setupDone: false });
  res.json({ ...db.settings });
});

app.post('/api/setup', (req, res) => {
  if (!req.localTrusted) return res.status(403).json({ error: 'Setup is only available on the office PC.' });
  const { schoolName, academicYear, terms, adminName, demoData } = req.body;
  if (typeof schoolName !== 'string' || !schoolName.trim()) return res.status(400).json({ error: 'School name required' });
  if (db && db.settings?.setupDone) return res.status(400).json({ error: 'Already set up' });

  db = {
    settings: {
      schoolName: schoolName.trim().slice(0, 120),
      academicYear: cleanText(academicYear, 20) || new Date().getFullYear() + '-' + (new Date().getFullYear() + 1).toString().slice(2),
      terms: Array.isArray(terms) ? terms : [],
      lockAfterHours: 24,
      setupDone: true,
      serverId: uuid(),
      fingerprint: crypto.randomBytes(8).toString('hex'),
    },
    users: [{ id: uuid(), name: cleanText(adminName, 100) || 'Admin', role: 'admin', active: true }],
    classes: [], students: [], assignments: [], devices: [], enrollmentTokens: [],
    attendance: [], corrections: [], log: [], holidays: [],
  };
  if (demoData) {
    const cls = [{ id: 'c5a', name: '5', division: 'A', label: '5-A' }, { id: 'c5b', name: '5', division: 'B', label: '5-B' }];
    db.classes.push(...cls);
    const names = ['Aarav Patel', 'Diya Shah', 'Vivaan Mehta', 'Isha Joshi', 'Kabir Desai', 'Riya Bhatt'];
    for (const c of cls) names.forEach((n, i) => db.students.push({ id: uuid(), studentId: '', name: n, rollNo: i + 1, classId: c.id, guardianName: '', phone: '', active: true }));
  }
  saveDb();
  addLog('setup', null, schoolName);
  res.json({ ok: true });
});

app.put('/api/settings', (req, res) => {
  const allowed = ['schoolName', 'academicYear', 'terms', 'lockAfterHours', 'maxDevicesPerUser', 'correctionRequiresApproval'];
  for (const k of allowed) {
    if (req.body[k] !== undefined) db.settings[k] = req.body[k];
  }
  saveDb();
  addLog('settings_change', null, Object.keys(req.body).join(', '));
  res.json(db.settings);
});

// ======== USERS ========

app.get('/api/users', (_req, res) => res.json(db.users.filter(u => u.active !== false)));
app.get('/api/users/all', (_req, res) => res.json(db.users));

app.post('/api/users', (req, res) => {
  const { name, role } = req.body;
  if (typeof name !== 'string' || !name.trim() || !['admin', 'class_teacher', 'subject_teacher'].includes(role)) {
    return res.status(400).json({ error: 'Name and valid role required' });
  }
  const user = { id: uuid(), name: cleanText(name, 100), role, active: true };
  db.users.push(user);
  saveDb();
  addLog('user_add', null, `${name} (${role})`);
  res.status(201).json(user);
});

app.put('/api/users/:id', (req, res) => {
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) user.name = cleanText(req.body.name, 100);
  if (req.body.role && ['admin', 'class_teacher', 'subject_teacher'].includes(req.body.role)) user.role = req.body.role;
  saveDb();
  addLog('user_edit', null, user.name);
  res.json(user);
});

app.post('/api/users/:id/toggle', (req, res) => {
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.active = !user.active;
  saveDb();
  addLog('user_toggle', null, `${user.name} → ${user.active ? 'active' : 'disabled'}`);
  res.json(user);
});

// ======== CLASSES ========

app.get('/api/classes', (_req, res) => res.json(db.classes));

app.post('/api/classes', (req, res) => {
  const { name, division } = req.body;
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Class name required' });
  const className = cleanText(name, 30);
  const classDivision = cleanText(division, 20);
  const label = classDivision ? `${className}-${classDivision}` : className;
  const id = 'c' + label.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (db.classes.find(c => c.id === id)) return res.status(400).json({ error: 'Class already exists' });
  const cls = { id, name: className, division: classDivision, label };
  db.classes.push(cls);
  saveDb();
  addLog('class_add', null, label);
  res.status(201).json(cls);
});

app.put('/api/classes/:id', (req, res) => {
  const cls = db.classes.find(c => c.id === req.params.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) { cls.name = cleanText(req.body.name, 30); cls.label = cls.division ? `${cls.name}-${cls.division}` : cls.name; }
  if (req.body.division !== undefined) { cls.division = cleanText(req.body.division, 20); cls.label = cls.division ? `${cls.name}-${cls.division}` : cls.name; }
  saveDb();
  res.json(cls);
});

// ======== STUDENTS ========

app.get('/api/students', (req, res) => {
  const { classId } = req.query;
  let list = db.students.filter(s => s.active !== false);
  if (classId) list = list.filter(s => s.classId === classId);
  res.json(list.sort((a, b) => a.rollNo - b.rollNo));
});

// CSV sample download (admin)
app.get('/api/students/csv-sample', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=student-import-sample.csv');
  res.send('student_id,roll_no,full_name,class,division,guardian_name,phone,active\n,1,Aarav Patel,5,A,Ramesh Patel,9876543210,yes\n,2,Diya Shah,5,A,,,yes\n');
});

// ponytail: keep old path for teacher PWA — single class roster (user level)
app.get('/api/students/:classId', (req, res) => {
  if (!canAccessClass(req, req.params.classId, today())) return res.status(403).json({ error: 'This class is not assigned to you.' });
  const list = db.students.filter(s => s.classId === req.params.classId && s.active !== false);
  res.json(list.sort((a, b) => a.rollNo - b.rollNo));
});

app.post('/api/students', (req, res) => {
  const { name, rollNo, classId, studentId, guardianName, phone } = req.body;
  if (typeof name !== 'string' || !name.trim() || !classId) return res.status(400).json({ error: 'Name and class required' });
  if (!db.classes.find(c => c.id === classId)) return res.status(400).json({ error: 'Class not found' });
  const rn = parseInt(rollNo) || (db.students.filter(s => s.classId === classId).length + 1);
  if (db.students.find(s => s.classId === classId && s.rollNo === rn && s.active !== false)) {
    return res.status(400).json({ error: `Roll number ${rn} already exists in this class` });
  }
  if (studentId && db.students.find(s => s.studentId === studentId && s.active !== false)) {
    return res.status(400).json({ error: `Student ID ${studentId} already exists` });
  }
  const student = {
    id: uuid(), studentId: cleanText(studentId, 50), name: cleanText(name, 120), rollNo: rn, classId,
    guardianName: cleanText(guardianName, 120), phone: cleanText(phone, 30), active: true,
  };
  db.students.push(student);
  saveDb();
  addLog('student_add', null, `${name} → ${classId}`);
  res.status(201).json(student);
});

app.put('/api/students/:id', (req, res) => {
  const s = db.students.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) s.name = cleanText(req.body.name, 120);
  if (req.body.rollNo) s.rollNo = parseInt(req.body.rollNo);
  if (req.body.guardianName !== undefined) s.guardianName = cleanText(req.body.guardianName, 120);
  if (req.body.phone !== undefined) s.phone = cleanText(req.body.phone, 30);
  saveDb();
  addLog('student_edit', null, s.name);
  res.json(s);
});

app.post('/api/students/:id/toggle', (req, res) => {
  const s = db.students.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  s.active = !s.active;
  saveDb();
  addLog('student_toggle', null, `${s.name} → ${s.active ? 'active' : 'inactive'}`);
  res.json(s);
});

app.post('/api/students/:id/move', (req, res) => {
  const s = db.students.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const { classId, rollNo } = req.body;
  if (!db.classes.find(c => c.id === classId)) return res.status(400).json({ error: 'Class not found' });
  const oldClass = s.classId;
  s.classId = classId;
  if (rollNo) s.rollNo = parseInt(rollNo);
  saveDb();
  addLog('student_move', null, `${s.name}: ${oldClass} → ${classId}`);
  res.json(s);
});

// CSV import — supports full-spec columns; returns preview/validation when preview=true (edges 63-67)
app.post('/api/students/import', (req, res) => {
  const { classId, csv, preview } = req.body;
  if (!classId || typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'classId and csv required' });
  if (!db.classes.find(c => c.id === classId)) return res.status(400).json({ error: 'Class not found' });

  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const i = headers.indexOf(n); if (i !== -1) return i; } return -1; };
  const nameIdx = col('full_name', 'name');
  const rollIdx = col('roll_no', 'rollno');
  const sidIdx = col('student_id', 'studentid');
  const guardIdx = col('guardian_name', 'guardian');
  const phoneIdx = col('phone');
  if (nameIdx === -1) return res.status(400).json({ error: 'CSV must have a "full_name" (or "name") column' });

  const errors = [];
  const valid = [];
  const seenRoll = new Set(db.students.filter(s => s.classId === classId && s.active !== false).map(s => s.rollNo));
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = lines[i].split(',').map(v => v.trim());
    const name = vals[nameIdx];
    if (!name) { errors.push(`Row ${i + 1}: empty name`); continue; }
    let rollNo = rollIdx >= 0 ? parseInt(vals[rollIdx]) : (seenRoll.size + valid.length + 1);
    if (!rollNo) rollNo = seenRoll.size + valid.length + 1;
    if (seenRoll.has(rollNo) || valid.find(v => v.rollNo === rollNo)) { errors.push(`Row ${i + 1}: roll ${rollNo} already exists`); continue; }
    const studentId = sidIdx >= 0 ? vals[sidIdx] : '';
    if (studentId && db.students.find(s => s.studentId === studentId && s.active !== false)) { errors.push(`Row ${i + 1}: student_id ${studentId} already exists`); continue; }
    valid.push({ id: uuid(), studentId, name, rollNo, classId, guardianName: guardIdx >= 0 ? vals[guardIdx] || '' : '', phone: phoneIdx >= 0 ? vals[phoneIdx] || '' : '', active: true });
  }

  if (preview) return res.json({ preview: true, validCount: valid.length, errorCount: errors.length, errors, sample: valid.slice(0, 5) });

  db.students.push(...valid);
  saveDb();
  addLog('student_import', null, `${valid.length} students → ${classId}`);
  res.json({ added: valid.length, errors });
});

// ======== ASSIGNMENTS ========

app.get('/api/assignments', (_req, res) => res.json(db.assignments));

app.get('/api/my-assignments', (req, res) => {
  if (!req.device) return res.status(401).json({ error: 'Not paired' });
  const userId = req.device.userId;
  const currentDate = today();
  const dayName = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];

  const mine = db.assignments.filter(a => {
    if (a.userId !== userId) return false;
    if (a.startDate && currentDate < a.startDate) return false;
    if (a.endDate && currentDate > a.endDate) return false;
    if (a.days && !a.days.includes(dayName)) return false;
    return true;
  });
  res.json(mine.map(a => ({ ...a, classLabel: db.classes.find(c => c.id === a.classId)?.label || a.classId })));
});

app.post('/api/assignments', (req, res) => {
  const { userId, classId, type, days, startDate, endDate, temporary, substituteFor, reason } = req.body;
  if (!userId || !classId || !type) return res.status(400).json({ error: 'userId, classId, type required' });
  if (!db.users.find(u => u.id === userId)) return res.status(400).json({ error: 'User not found' });
  if (!db.classes.find(c => c.id === classId)) return res.status(400).json({ error: 'Class not found' });

  // Overlap warning (edges 69-71) — does not block, returned for confirmation
  const overlaps = db.assignments.filter(a => a.classId === classId && a.type === type && a.userId !== userId)
    .map(a => db.users.find(u => u.id === a.userId)?.name).filter(Boolean);

  if (type === 'class_teacher') {
    db.assignments = db.assignments.filter(a => !(a.classId === classId && a.type === 'class_teacher'));
  }

  const assignment = {
    id: uuid(), userId, classId, type,
    days: days || null, startDate: startDate || null, endDate: endDate || null,
    temporary: temporary || false, substituteFor: substituteFor || null, reason: cleanText(reason, 500),
  };
  db.assignments.push(assignment);
  saveDb();
  const userName = db.users.find(u => u.id === userId)?.name;
  const classLabel = db.classes.find(c => c.id === classId)?.label;
  addLog('assignment_add', null, `${userName} → ${classLabel} (${type})`);
  res.status(201).json({ ...assignment, overlapsWith: overlaps });
});

app.delete('/api/assignments/:id', (req, res) => {
  const idx = db.assignments.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Assignment not found' });
  const removed = db.assignments.splice(idx, 1)[0];
  saveDb();
  addLog('assignment_remove', null, `${removed.userId} from ${removed.classId}`);
  res.json({ ok: true });
});

// ======== INVITES / ENROLLMENT ========

function appTypeForRole(role) { return role === 'admin' ? 'admin' : 'teacher'; }

function makeInvite(user) {
  // Invalidate previous unused invites for this user
  db.enrollmentTokens.forEach(t => { if (t.userId === user.id && !t.used) t.used = true; });
  const now = Date.now();
  const invite = {
    id: uuid(),
    token: uuid(),
    code: String(Math.floor(100000 + Math.random() * 900000)),
    userId: user.id,
    role: user.role,
    appType: appTypeForRole(user.role),
    serverId: db.settings.serverId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
    used: false,
  };
  db.enrollmentTokens.push(invite);
  saveDb();
  return invite;
}

async function inviteQR(invite, serverUrl) {
  // QR carries the resolver: server endpoint (so the device can reach signalling) + token + code
  const payload = JSON.stringify({ v: 2, server: serverUrl, token: invite.token, code: invite.code, role: invite.role, appType: invite.appType });
  return QRCode.toDataURL(payload, { width: 320, margin: 2 });
}

// Create invite (new path + backward-compatible alias)
async function handleInvite(req, res) {
  const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const invite = makeInvite(user);
  const serverUrl = getServerUrl(req);
  const qr = await inviteQR(invite, serverUrl);
  addLog('invite_create', user.id, `${user.name} (${invite.appType})`);
  res.json({
    qr, code: invite.code, token: invite.token,
    role: invite.role, appType: invite.appType, userName: user.name,
    expiresAt: invite.expiresAt, server: serverUrl,
  });
}
// ponytail: /validate must be registered BEFORE /:userId or Express treats "validate" as a userId
app.post('/api/invite/validate', (req, res) => {
  if (!rateOk(req)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
  const st = inviteState(findInvite(req.body));
  if (!st.ok) return res.status(st.status).json({ valid: false, error: st.error });
  res.json({ valid: true, role: st.invite.role, appType: st.invite.appType, schoolName: db.settings.schoolName, expiresAt: st.invite.expiresAt });
});
app.post('/api/invite/:userId', handleInvite);
app.post('/api/enrollment-qr/:userId', handleInvite); // ponytail: alias for older callers

function findInvite({ token, code }) {
  if (token) return db.enrollmentTokens.find(t => t.token === token);
  if (code) return db.enrollmentTokens.find(t => t.code === code);
  return null;
}
function inviteState(invite) {
  if (!invite) return { ok: false, status: 404, error: 'Code not found. Check the 6 digits or ask admin for a new code.' };
  if (invite.used) return { ok: false, status: 410, error: 'This code was already used. Ask admin for a new code.' };
  if (Date.now() > new Date(invite.expiresAt || 0).getTime()) return { ok: false, status: 410, error: 'This code has expired. Ask admin to generate a new code.' };
  return { ok: true, invite };
}

// rate-limit enroll/validate per IP (edges 101,102)
const attempts = new Map();
function rateOk(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').split(',')[0];
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now > a.reset) { a = { count: 0, reset: now + 10 * 60 * 1000 }; attempts.set(ip, a); }
  a.count++;
  return a.count <= 12;
}

app.post('/api/enroll', (req, res) => {
  if (!rateOk(req)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
  const { token, code, deviceId, appType } = req.body;
  if ((!token && !code) || !deviceId) return res.status(400).json({ error: 'Token or code, and deviceId required' });
  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(deviceId)) return res.status(400).json({ error: 'Invalid device identity' });

  const st = inviteState(findInvite({ token, code }));
  if (!st.ok) return res.status(st.status).json({ error: st.error });
  const invite = st.invite;

  // App/role match (edges 10-13) — enforced server-side now
  if (appType && invite.appType !== appType) {
    return res.status(403).json({ error: `This code is for the ${invite.appType} app, not the ${appType} app.` });
  }

  // Device-count limit per user (edge 15)
  const max = db.settings.maxDevicesPerUser || 2;
  const userDevices = db.devices.filter(d => d.userId === invite.userId && !d.revoked);
  const reuse = userDevices.find(d => d.deviceId === deviceId);
  if (!reuse && userDevices.length >= max) {
    return res.status(409).json({ error: `This user already has ${max} paired device(s). Admin must remove one first.` });
  }

  invite.used = true;
  const deviceToken = crypto.randomBytes(24).toString('hex'); // the shared "connection key"
  let device = db.devices.find(d => d.deviceId === deviceId && d.userId === invite.userId);
  if (device) {
    device.tokenHash = hashToken(deviceToken);
    delete device.token;
    device.revoked = false;
    device.lastSeen = new Date().toISOString();
  }
  else {
    device = { deviceId, userId: invite.userId, role: invite.role, tokenHash: hashToken(deviceToken), enrolledAt: new Date().toISOString(), lastSeen: new Date().toISOString(), revoked: false };
    db.devices.push(device);
  }
  saveDb();

  const user = db.users.find(u => u.id === invite.userId);
  addLog('enroll', invite.userId, `${user?.name} device ${deviceId.slice(0, 12)}`);
  res.json({ ok: true, user: sanitizeUser(user), deviceToken, server: serverInfo() });
});

// ======== DEVICE AUTH ========

app.get('/api/me', (req, res) => {
  if (req.device) {
    const user = db.users.find(u => u.id === req.device.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Authenticated devices get the FULL ICE list (including TURN credentials, if configured).
    return res.json({ ...sanitizeUser(user), iceServers: ICE_SERVERS });
  }
  if (req.localTrusted) {
    const admin = db.users.find(u => u.role === 'admin' && u.active !== false);
    if (admin) return res.json(sanitizeUser(admin));
  }
  res.status(401).json({ error: 'Not paired' });
});

// ======== DEVICES ========

app.get('/api/devices', (_req, res) => {
  res.json(db.devices.map(d => {
    const user = db.users.find(u => u.id === d.userId);
    return { deviceId: d.deviceId, userId: d.userId, userName: user?.name, userRole: user?.role, revoked: d.revoked, enrolledAt: d.enrolledAt, lastSeen: d.lastSeen };
  }));
});

app.post('/api/revoke/:deviceId', (req, res) => {
  const device = db.devices.find(d => d.deviceId === req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  device.revoked = true;
  saveDb();
  addLog('revoke', null, req.params.deviceId.slice(0, 12));
  res.json({ ok: true });
});

app.post('/api/unrevoke/:deviceId', (req, res) => {
  const device = db.devices.find(d => d.deviceId === req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  device.revoked = false;
  saveDb();
  res.json({ ok: true });
});

// ======== ATTENDANCE ========

app.post('/api/attendance', (req, res) => {
  const { records } = req.body; // [{ classId, studentId, date, status, markedBy, note, opId }]
  if (!Array.isArray(records)) return res.status(400).json({ error: 'Records array required' });
  if (!records.length) return res.status(400).json({ error: 'At least one record is required' });
  const statuses = new Set(['present', 'absent', 'late', 'leave']);
  const lockHours = db.settings.lockAfterHours || 0;
  for (const r of records) {
    const student = db.students.find(s => s.id === r.studentId && s.classId === r.classId && s.active !== false);
    if (!student) return res.status(400).json({ error: 'Student does not belong to this class.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) return res.status(400).json({ error: 'Invalid attendance date.' });
    if (!statuses.has(r.status)) return res.status(400).json({ error: 'Invalid attendance status.' });
    if (!canAccessClass(req, r.classId, r.date, true)) return res.status(403).json({ error: 'You cannot mark attendance for this class or date.' });
    const existing = db.attendance.find(a => a.classId === r.classId && a.studentId === r.studentId && a.date === r.date);
    if (lockHours && isLocked(r.date, lockHours) && !existing) {
      return res.status(409).json({ error: 'Attendance is locked. Ask the admin to add this missing record.' });
    }
  }

  let added = 0, updated = 0, locked = 0, duplicate = 0, conflicts = 0, corrections = 0;
  if (!db.syncedOps) db.syncedOps = [];
  const remember = opId => {
    if (!opId) return;
    db.syncedOps.push(opId);
    if (db.syncedOps.length > 20000) db.syncedOps = db.syncedOps.slice(-15000);
  };

  for (const r of records) {
    // Idempotency: ignore exact duplicate operations (edges 47,48)
    if (r.opId) {
      if (db.syncedOps.includes(r.opId)) { duplicate++; continue; }
    }
    const idx = db.attendance.findIndex(a => a.classId === r.classId && a.studentId === r.studentId && a.date === r.date);
    if (idx >= 0) {
      const existing = db.attendance[idx];
      const changed = existing.status !== r.status || (r.note != null && cleanText(r.note, 500) !== (existing.note || ''));
      if (lockHours && isLocked(r.date, lockHours)) {
        locked++;
        if (changed) {
          queueAttendanceCorrection(existing, r, req, 'Edit submitted after attendance was locked');
          corrections++;
        } else duplicate++;
        remember(r.opId);
        continue;
      }
      const otherDevice = req.device && existing.deviceId && existing.deviceId !== req.device.deviceId;
      if (changed && otherDevice && req.user?.role !== 'admin') {
        queueAttendanceCorrection(existing, r, req, 'Conflicting attendance received from another device');
        conflicts++;
        remember(r.opId);
        continue;
      }
      if (!existing.history) existing.history = [];
      existing.history.push({ status: existing.status, changedBy: existing.markedBy, changedAt: existing.markedAt, reason: 'update' });
      existing.status = r.status || 'present';
      existing.markedBy = req.user?.id || 'local-admin';
      existing.markedByRole = req.user?.role || 'admin';
      existing.markedAt = new Date().toISOString();
      existing.note = cleanText(r.note, 500) || existing.note || '';
      existing.deviceId = req.device?.deviceId || 'local-admin';
      updated++;
    } else {
      db.attendance.push({
        id: uuid(), studentId: r.studentId, classId: r.classId, date: r.date,
        status: r.status || 'present', markedBy: req.user?.id || 'local-admin', markedByRole: req.user?.role || 'admin',
        deviceId: req.device?.deviceId || 'local-admin', markedAt: new Date().toISOString(), syncedAt: new Date().toISOString(),
        clientTime: r.clientTime || null, note: cleanText(r.note, 500), history: [],
      });
      added++;
    }
    remember(r.opId);
  }
  saveDb();
  res.json({ ok: true, added, updated, locked, duplicate, conflicts, corrections, total: records.length, serverDate: today() });
});

function queueAttendanceCorrection(att, record, req, reason) {
  db.corrections.push({
    id: uuid(), opId: record.opId || null, attendanceId: att.id,
    requestedBy: req.device?.deviceId || 'local-admin',
    requestedByName: req.user?.name || 'Local Admin',
    oldStatus: att.status, newStatus: record.status, reason,
    status: 'pending', requestedAt: new Date().toISOString(), reviewedBy: null, reviewedAt: null,
  });
  addLog('attendance_conflict', req.user?.id, `${att.studentId}: ${att.status} → ${record.status}`);
}

app.get('/api/attendance/:classId/:date', (req, res) => {
  const { classId, date } = req.params;
  if (!canAccessClass(req, classId, date)) return res.status(403).json({ error: 'This class is not assigned to you.' });
  res.json(db.attendance.filter(a => a.classId === classId && a.date === date));
});

app.get('/api/attendance-summary/:classId', (req, res) => {
  const { classId } = req.params;
  if (!canAccessClass(req, classId, null, false, true)) return res.status(403).json({ error: 'This report is not available to you.' });
  const students = db.students.filter(s => s.classId === classId && s.active !== false);
  const records = db.attendance.filter(a => a.classId === classId);
  const dates = [...new Set(records.map(r => r.date))].sort();
  const summary = students.map(s => {
    const sr = records.filter(r => r.studentId === s.id);
    const present = sr.filter(r => r.status === 'present' || r.status === 'late').length;
    const total = sr.length;
    return { studentId: s.id, name: s.name, rollNo: s.rollNo, present, absent: total - present, total, percentage: total ? Math.round((present / total) * 100) : 0 };
  });
  res.json({ dates, summary });
});

// ======== CORRECTIONS ========

app.post('/api/corrections', (req, res) => {
  const { attendanceId, newStatus, reason } = req.body;
  if (!attendanceId || !['present', 'absent', 'late', 'leave'].includes(newStatus)) return res.status(400).json({ error: 'attendanceId and valid newStatus required' });
  const att = db.attendance.find(a => a.id === attendanceId);
  if (!att) return res.status(404).json({ error: 'Attendance record not found' });
  if (!canAccessClass(req, att.classId, att.date, true)) return res.status(403).json({ error: 'This attendance record is not assigned to you.' });
  const correction = {
    id: uuid(), attendanceId,
    requestedBy: req.device?.deviceId || 'local-admin',
    requestedByName: req.user?.name || 'Local Admin',
    oldStatus: att.status, newStatus, reason: cleanText(reason, 500),
    status: 'pending', requestedAt: new Date().toISOString(), reviewedBy: null, reviewedAt: null,
  };
  db.corrections.push(correction);
  saveDb();
  addLog('correction_request', req.device?.userId, `${att.studentId} → ${newStatus}`);
  res.status(201).json(correction);
});

app.get('/api/corrections', (_req, res) => {
  res.json(db.corrections.map(c => {
    const att = db.attendance.find(a => a.id === c.attendanceId);
    const student = att ? db.students.find(s => s.id === att.studentId) : null;
    const cls = att ? db.classes.find(cl => cl.id === att.classId) : null;
    return { ...c, studentName: student?.name, classLabel: cls?.label, date: att?.date };
  }));
});

app.post('/api/corrections/:id/approve', (req, res) => {
  const c = db.corrections.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Correction not found' });
  c.status = 'approved'; c.reviewedBy = 'admin'; c.reviewedAt = new Date().toISOString();
  const att = db.attendance.find(a => a.id === c.attendanceId);
  if (att) {
    if (!att.history) att.history = [];
    att.history.push({ status: att.status, changedBy: 'correction', changedAt: new Date().toISOString(), reason: c.reason });
    att.status = c.newStatus;
  }
  saveDb();
  addLog('correction_approve', null, c.id);
  res.json(c);
});

app.post('/api/corrections/:id/reject', (req, res) => {
  const c = db.corrections.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Correction not found' });
  c.status = 'rejected'; c.reviewedBy = 'admin'; c.reviewedAt = new Date().toISOString();
  saveDb();
  addLog('correction_reject', null, c.id);
  res.json(c);
});

// ======== HOLIDAYS ========

app.get('/api/holidays', (_req, res) => res.json(db.holidays));
app.post('/api/holidays', (req, res) => {
  const { date, name } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'valid date required' });
  if (!db.holidays.find(h => h.date === date)) db.holidays.push({ date, name: cleanText(name, 100) || 'Holiday' });
  saveDb();
  addLog('holiday_add', null, date);
  res.json(db.holidays);
});
app.delete('/api/holidays/:date', (req, res) => {
  db.holidays = db.holidays.filter(h => h.date !== req.params.date);
  saveDb();
  res.json({ ok: true });
});

// ======== REPORTS ========

app.get('/api/reports/daily/:classId/:date', (req, res) => {
  const { classId, date } = req.params;
  if (!canAccessClass(req, classId, date, false, true)) return res.status(403).json({ error: 'This report is not available to you.' });
  const students = db.students.filter(s => s.classId === classId && s.active !== false).sort((a, b) => a.rollNo - b.rollNo);
  const records = db.attendance.filter(a => a.classId === classId && a.date === date);
  const cls = db.classes.find(c => c.id === classId);
  const rows = students.map(s => {
    const rec = records.find(r => r.studentId === s.id);
    return { rollNo: s.rollNo, name: s.name, studentId: s.id, status: rec?.status || 'not_marked', note: rec?.note || '', markedBy: rec?.markedBy || '', markedAt: rec?.markedAt || '' };
  });
  const stats = {
    total: students.length,
    present: rows.filter(r => r.status === 'present').length,
    absent: rows.filter(r => r.status === 'absent').length,
    late: rows.filter(r => r.status === 'late').length,
    leave: rows.filter(r => r.status === 'leave').length,
    notMarked: rows.filter(r => r.status === 'not_marked').length,
  };
  res.json({ classLabel: cls?.label, date, rows, stats });
});

app.get('/api/reports/weekly/:classId', (req, res) => {
  const { classId } = req.params;
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end query params required' });
  if (!canAccessClass(req, classId, start, false, true)) return res.status(403).json({ error: 'This report is not available to you.' });
  const students = db.students.filter(s => s.classId === classId && s.active !== false).sort((a, b) => a.rollNo - b.rollNo);
  const records = db.attendance.filter(a => a.classId === classId && a.date >= start && a.date <= end);
  const dates = [];
  for (let d = new Date(start + 'T12:00:00'); d <= new Date(end + 'T12:00:00'); d.setDate(d.getDate() + 1)) dates.push(today(d));
  const rows = students.map(s => {
    const dayStatuses = {};
    for (const date of dates) { const rec = records.find(r => r.studentId === s.id && r.date === date); dayStatuses[date] = rec?.status || '-'; }
    const sr = records.filter(r => r.studentId === s.id);
    const present = sr.filter(r => r.status === 'present' || r.status === 'late').length;
    return { rollNo: s.rollNo, name: s.name, days: dayStatuses, present, total: sr.length };
  });
  res.json({ classLabel: db.classes.find(c => c.id === classId)?.label, dates, rows });
});

app.get('/api/reports/monthly/:classId/:month', (req, res) => {
  const { classId, month } = req.params;
  if (!canAccessClass(req, classId, month + '-01', false, true)) return res.status(403).json({ error: 'This report is not available to you.' });
  const students = db.students.filter(s => s.classId === classId && s.active !== false).sort((a, b) => a.rollNo - b.rollNo);
  const records = db.attendance.filter(a => a.classId === classId && a.date.startsWith(month));
  const rows = students.map(s => {
    const sr = records.filter(r => r.studentId === s.id);
    const present = sr.filter(r => r.status === 'present' || r.status === 'late').length;
    const absent = sr.filter(r => r.status === 'absent').length;
    const leave = sr.filter(r => r.status === 'leave').length;
    return { rollNo: s.rollNo, name: s.name, studentId: s.id, present, absent, leave, total: sr.length, percentage: sr.length ? Math.round((present / sr.length) * 100) : 0 };
  });
  res.json({ classLabel: db.classes.find(c => c.id === classId)?.label, month, rows });
});

app.get('/api/reports/student/:studentId', (req, res) => {
  const student = db.students.find(s => s.id === req.params.studentId);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  if (!canAccessClass(req, student.classId, null, false, true)) return res.status(403).json({ error: 'This report is not available to you.' });
  const records = db.attendance.filter(a => a.studentId === student.id).sort((a, b) => a.date.localeCompare(b.date));
  const present = records.filter(r => r.status === 'present' || r.status === 'late').length;
  const cls = db.classes.find(c => c.id === student.classId);
  res.json({ student: { ...student, classLabel: cls?.label }, records, summary: { present, absent: records.length - present, total: records.length, percentage: records.length ? Math.round((present / records.length) * 100) : 0 } });
});

app.get('/api/reports/absentees/:date', (req, res) => {
  const { date } = req.params;
  const absentees = [];
  for (const cls of db.classes) {
    for (const s of db.students.filter(s => s.classId === cls.id && s.active !== false)) {
      const rec = db.attendance.find(a => a.studentId === s.id && a.date === date);
      if (rec && rec.status === 'absent') absentees.push({ classLabel: cls.label, rollNo: s.rollNo, name: s.name, studentId: s.id });
    }
  }
  res.json({ date, absentees });
});

app.get('/api/reports/missing/:date', (req, res) => {
  const { date } = req.params;
  const missing = [];
  for (const cls of db.classes) {
    const students = db.students.filter(s => s.classId === cls.id && s.active !== false);
    const records = db.attendance.filter(a => a.classId === cls.id && a.date === date);
    const marked = students.filter(s => records.some(r => r.studentId === s.id)).length;
    if (marked < students.length) {
      const teacher = db.assignments.find(a => a.classId === cls.id && a.type === 'class_teacher');
      const teacherName = teacher ? db.users.find(u => u.id === teacher.userId)?.name : 'Not assigned';
      missing.push({ classId: cls.id, classLabel: cls.label, total: students.length, marked, teacherName });
    }
  }
  res.json({ date, missing });
});

app.get('/api/reports/low-attendance/:threshold', (req, res) => {
  const threshold = parseInt(req.params.threshold) || 75;
  const low = [];
  for (const s of db.students.filter(s => s.active !== false)) {
    const sr = db.attendance.filter(a => a.studentId === s.id);
    if (!sr.length) continue;
    const present = sr.filter(r => r.status === 'present' || r.status === 'late').length;
    const pct = Math.round((present / sr.length) * 100);
    if (pct < threshold) low.push({ name: s.name, rollNo: s.rollNo, classLabel: db.classes.find(c => c.id === s.classId)?.label, percentage: pct, total: sr.length });
  }
  res.json({ threshold, students: low.sort((a, b) => a.percentage - b.percentage) });
});

// CSV export
app.get('/api/reports/export/:classId/:type', (req, res) => {
  const { classId, type } = req.params;
  if (!canAccessClass(req, classId, null, false, true)) return res.status(403).json({ error: 'This report is not available to you.' });
  const cls = db.classes.find(c => c.id === classId);
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  const students = db.students.filter(s => s.classId === classId && s.active !== false).sort((a, b) => a.rollNo - b.rollNo);
  const records = db.attendance.filter(a => a.classId === classId);
  let csv = '';
  if (type === 'summary') {
    csv = 'Roll No,Name,Present,Absent,Late,Leave,Total,Percentage\n';
    for (const s of students) {
      const sr = records.filter(r => r.studentId === s.id);
      const p = sr.filter(r => r.status === 'present').length;
      const a = sr.filter(r => r.status === 'absent').length;
      const l = sr.filter(r => r.status === 'late').length;
      const lv = sr.filter(r => r.status === 'leave').length;
      const pct = sr.length ? Math.round(((p + l) / sr.length) * 100) : 0;
      csv += `${s.rollNo},${s.name},${p},${a},${l},${lv},${sr.length},${pct}%\n`;
    }
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${cls.label}-${type}.csv`);
  res.send(csv);
});

// ======== AUDIT LOG ========

app.get('/api/audit', (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(db.log.slice(-limit).reverse());
});

// ======== BACKUP ========

app.get('/api/backup/download', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=attendance-backup-${today()}.json`);
  res.send(JSON.stringify(db, null, 2));
});

app.post('/api/backup/restore', (req, res) => {
  const data = req.body;
  if (!data || !data.settings || !data.users || !data.classes) {
    return res.status(400).json({ error: 'Invalid backup file. Must contain settings, users, and classes.' });
  }
  createBackup(); // pre-restore safety backup (edge 72)
  db = data;
  ensureSchema();
  saveDb();
  addLog('restore', null, 'Database restored from backup');
  res.json({ ok: true, users: db.users.length, students: db.students.length, classes: db.classes.length });
});

app.get('/api/backup/list', (_req, res) => {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort().reverse();
  res.json(files.map(f => { const stat = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: stat.size, date: stat.mtime.toISOString() }; }));
});

app.post('/api/backup/create', (_req, res) => {
  const name = createBackup();
  res.json({ ok: !!name, name });
});

app.get('/api/backup/status', (_req, res) => {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort();
  const last = files.length ? files[files.length - 1] : null;
  res.json({ lastBackup: last ? fs.statSync(path.join(BACKUP_DIR, last)).mtime.toISOString() : null, backupCount: files.length, backupDir: BACKUP_DIR });
});

// ======== JSON-ONLY 404 + ERROR HANDLER ========
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
app.use((err, _req, res, _next) => {
  console.error('API error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// ======== HELPERS ========

function sanitizeUser(user) {
  if (!user) return null;
  const assignments = db.assignments.filter(a => a.userId === user.id);
  return { id: user.id, name: user.name, role: user.role, active: user.active, assignments };
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function today(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function assignmentActive(a, date) {
  if (a.startDate && date && date < a.startDate) return false;
  if (a.endDate && date && date > a.endDate) return false;
  if (a.days && date) {
    const days = Array.isArray(a.days) ? a.days : String(a.days).split(',');
    const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(date + 'T12:00:00').getDay()];
    if (!days.map(d => d.trim().toLowerCase()).includes(day)) return false;
  }
  return true;
}

function canAccessClass(req, classId, date, write = false, report = false) {
  if (req.localTrusted || req.user?.role === 'admin') return true;
  if (!req.user) return false;
  return db.assignments.some(a => {
    if (a.userId !== req.user.id || a.classId !== classId) return false;
    if (report && a.type === 'subject_teacher') return false;
    if (write && a.editAllowed === false) return false;
    return assignmentActive(a, date);
  });
}

function getServerUrl(req) {
  if (global.TUNNEL_URL) return global.TUNNEL_URL;
  const host = (req && req.headers && req.headers.host) || `localhost:${PORT}`;
  return `${(req && req.protocol) || 'http'}://${host}`;
}

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
  }
  return 'localhost';
}

function isLocked(date, lockHours) {
  if (!lockHours) return false;
  const endOfDay = new Date(date + 'T23:59:59');
  const lockTime = new Date(endOfDay.getTime() + lockHours * 3600000);
  return new Date() > lockTime;
}

// ponytail: WebRTC DataChannel request -> internal loopback HTTP to our own routes.
// Reuses every Express handler. The bridge marker prevents local-trust bypass.
function dispatch(method, fullPath, body, ctx) {
  return new Promise((resolve) => {
    const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Content-Type': 'application/json', 'x-webrtc-bridge': '1' };
    if (ctx && ctx.token) headers['x-device-token'] = ctx.token;
    if (payload) headers['Content-Length'] = payload.length;
    const r = http.request({ host: '127.0.0.1', port: PORT, method: method || 'GET', path: fullPath, headers }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => { let parsed; try { parsed = JSON.parse(data || 'null'); } catch { parsed = { raw: data }; } resolve({ status: resp.statusCode, body: parsed }); });
    });
    r.on('error', e => resolve({ status: 502, body: { error: e.message } }));
    if (payload) r.write(payload);
    r.end();
  });
}

// ======== START ========

if (!db) {
  console.log('\n  First run! No db.json found. Open http://localhost:' + PORT + '/admin to set up, or run: npm run seed\n');
  db = { settings: { setupDone: false }, users: [], classes: [], students: [], assignments: [], devices: [], enrollmentTokens: [], attendance: [], corrections: [], log: [], holidays: [] };
  ensureSchema();
}

if (db.settings?.setupDone) createBackup();
setInterval(() => { if (db.settings?.setupDone) createBackup(); }, 24 * 60 * 60 * 1000);



const server = http.createServer(app);
let signalling = null;
let cleanupRtc = () => {};

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Another copy of the server may be running.`);
    console.error(`  Close it, or start on a different port:  PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log(`Server running (v${APP_VERSION})`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${lanIp}:${PORT}`);
  console.log(`  Admin:   http://localhost:${PORT}/admin`);
  console.log(`  App:     http://localhost:${PORT}/app`);
  if (db.settings?.setupDone) {
    console.log(`\n  ${db.settings.schoolName} — Users: ${db.users.length} | Classes: ${db.classes.length} | Students: ${db.students.length}`);
  }
  // WebRTC signalling pipeline over PeerJS public server
  if (!process.env.NO_SIGNAL) {
    const signal = require('./signal');
    cleanupRtc = signal.cleanupRtc;
    signalling = signal.attachSignal(server, { dispatch, iceServers: ICE_SERVERS, fingerprint: db.settings.fingerprint });
  }
});

function shutdown() {
  try { signalling?.close(); } catch {}
  server.close(() => {
    cleanupRtc();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
