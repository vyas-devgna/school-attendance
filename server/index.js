// ponytail: entire server in one file — all endpoints, JSON-file storage, backup
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');
const localtunnel = require('localtunnel');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');
const BACKUP_DIR = path.join(__dirname, 'backups');

app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id', 'Bypass-Tunnel-Reminder'] }));
app.use(express.json({ limit: '10mb' }));

// --- DB helpers ---
function loadDb() {
  if (!fs.existsSync(DB_PATH)) return null;
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDb() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function addLog(action, userId, detail) {
  db.log.push({ action, userId: userId || 'system', timestamp: new Date().toISOString(), detail: detail || '' });
  if (db.log.length > 5000) db.log = db.log.slice(-4000); // ponytail: cap log size
}

let db = loadDb();

// --- Backup helpers ---
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

function createBackup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `backup-${ts}.json`;
  try {
    fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(db, null, 2));
    // Keep last 30
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    return name;
  } catch (e) {
    console.error('Backup failed:', e.message);
    return null;
  }
}

// --- Serve static ---
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));
app.use('/app', express.static(path.join(__dirname, '..', 'app')));

// ======== SETTINGS / SETUP ========

app.get('/api/ping', (_req, res) => res.json({ ok: true }));

app.get('/api/settings', (_req, res) => {
  if (!db) return res.json({ setupDone: false });
  res.json(db.settings);
});

app.post('/api/setup', (req, res) => {
  const { schoolName, academicYear, terms, adminName, demoData } = req.body;
  if (!schoolName) return res.status(400).json({ error: 'School name required' });

  // ponytail: if db exists and setup done, block
  if (db && db.settings?.setupDone) return res.status(400).json({ error: 'Already set up' });

  db = {
    settings: {
      schoolName,
      academicYear: academicYear || new Date().getFullYear() + '-' + (new Date().getFullYear() + 1).toString().slice(2),
      terms: terms || [],
      lockAfterHours: 24,
      setupDone: true,
    },
    users: [{ id: uuid(), name: adminName || 'Admin', role: 'admin', active: true }],
    classes: [],
    students: [],
    assignments: [],
    devices: [],
    enrollmentTokens: [],
    attendance: [],
    corrections: [],
    log: [],
  };
  saveDb();
  addLog('setup', null, schoolName);
  res.json({ ok: true });
});

app.put('/api/settings', (req, res) => {
  const allowed = ['schoolName', 'academicYear', 'terms', 'lockAfterHours'];
  for (const k of allowed) {
    if (req.body[k] !== undefined) db.settings[k] = req.body[k];
  }
  saveDb();
  res.json(db.settings);
});

// ======== USERS ========

app.get('/api/users', (_req, res) => res.json(db.users.filter(u => u.active !== false)));

app.get('/api/users/all', (_req, res) => res.json(db.users));

app.post('/api/users', (req, res) => {
  const { name, role } = req.body;
  if (!name || !['admin', 'class_teacher', 'subject_teacher'].includes(role)) {
    return res.status(400).json({ error: 'Name and valid role required' });
  }
  const user = { id: uuid(), name, role, active: true };
  db.users.push(user);
  saveDb();
  addLog('user_add', null, `${name} (${role})`);
  res.status(201).json(user);
});

app.put('/api/users/:id', (req, res) => {
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (req.body.name) user.name = req.body.name;
  if (req.body.role && ['admin', 'class_teacher', 'subject_teacher'].includes(req.body.role)) user.role = req.body.role;
  saveDb();
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
  if (!name) return res.status(400).json({ error: 'Class name required' });
  const label = division ? `${name}-${division}` : name;
  const id = 'c' + label.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (db.classes.find(c => c.id === id)) return res.status(400).json({ error: 'Class already exists' });
  const cls = { id, name, division: division || '', label };
  db.classes.push(cls);
  saveDb();
  addLog('class_add', null, label);
  res.status(201).json(cls);
});

app.put('/api/classes/:id', (req, res) => {
  const cls = db.classes.find(c => c.id === req.params.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  if (req.body.name) { cls.name = req.body.name; cls.label = cls.division ? `${cls.name}-${cls.division}` : cls.name; }
  if (req.body.division !== undefined) { cls.division = req.body.division; cls.label = cls.division ? `${cls.name}-${cls.division}` : cls.name; }
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

// ponytail: keep old endpoint for backward compat with teacher PWA
app.get('/api/students/:classId', (req, res) => {
  const list = db.students.filter(s => s.classId === req.params.classId && s.active !== false);
  res.json(list.sort((a, b) => a.rollNo - b.rollNo));
});

app.post('/api/students', (req, res) => {
  const { name, rollNo, classId } = req.body;
  if (!name || !classId) return res.status(400).json({ error: 'Name and class required' });
  if (!db.classes.find(c => c.id === classId)) return res.status(400).json({ error: 'Class not found' });
  // Check duplicate rollNo in same class
  const rn = parseInt(rollNo) || (db.students.filter(s => s.classId === classId).length + 1);
  if (db.students.find(s => s.classId === classId && s.rollNo === rn && s.active !== false)) {
    return res.status(400).json({ error: `Roll number ${rn} already exists in this class` });
  }
  const student = { id: uuid(), name, rollNo: rn, classId, active: true };
  db.students.push(student);
  saveDb();
  addLog('student_add', null, `${name} → ${classId}`);
  res.status(201).json(student);
});

app.put('/api/students/:id', (req, res) => {
  const s = db.students.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  if (req.body.name) s.name = req.body.name;
  if (req.body.rollNo) s.rollNo = parseInt(req.body.rollNo);
  saveDb();
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

// CSV sample download
app.get('/api/students/csv-sample', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=student-import-sample.csv');
  res.send('name,rollNo\nAarav Patel,1\nDiya Shah,2\nVivaan Mehta,3\n');
});

// CSV import
app.post('/api/students/import', (req, res) => {
  const { classId, csv } = req.body;
  if (!classId || !csv) return res.status(400).json({ error: 'classId and csv required' });
  if (!db.classes.find(c => c.id === classId)) return res.status(400).json({ error: 'Class not found' });

  const lines = csv.trim().split('\n');
  if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header + data rows' });

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const nameIdx = headers.indexOf('name');
  const rollIdx = headers.indexOf('rollno');
  if (nameIdx === -1) return res.status(400).json({ error: 'CSV must have a "name" column' });

  const errors = [];
  const added = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim());
    const name = vals[nameIdx];
    if (!name) { errors.push(`Row ${i + 1}: empty name`); continue; }
    const rollNo = rollIdx >= 0 ? parseInt(vals[rollIdx]) : (db.students.filter(s => s.classId === classId).length + added.length + 1);
    if (db.students.find(s => s.classId === classId && s.rollNo === rollNo && s.active !== false)) {
      errors.push(`Row ${i + 1}: roll ${rollNo} already exists`);
      continue;
    }
    added.push({ id: uuid(), name, rollNo: rollNo || i, classId, active: true });
  }

  db.students.push(...added);
  saveDb();
  addLog('student_import', null, `${added.length} students → ${classId}`);
  res.json({ added: added.length, errors });
});

// ======== ASSIGNMENTS ========

app.get('/api/assignments', (_req, res) => res.json(db.assignments));

app.get('/api/my-assignments', (req, res) => {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) return res.status(401).json({ error: 'No device ID' });
  const device = db.devices.find(d => d.deviceId === deviceId && !d.revoked);
  if (!device) return res.status(401).json({ error: 'Not enrolled' });
  const userId = device.userId;
  const today = new Date().toISOString().slice(0, 10);
  const dayName = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];

  const myAssignments = db.assignments.filter(a => {
    if (a.userId !== userId) return false;
    // Check date range for temporary
    if (a.startDate && today < a.startDate) return false;
    if (a.endDate && today > a.endDate) return false;
    // Check day restriction
    if (a.days && !a.days.includes(dayName)) return false;
    return true;
  });

  // Enrich with class info
  const result = myAssignments.map(a => ({
    ...a,
    classLabel: db.classes.find(c => c.id === a.classId)?.label || a.classId,
  }));
  res.json(result);
});

app.post('/api/assignments', (req, res) => {
  const { userId, classId, type, days, startDate, endDate, temporary } = req.body;
  if (!userId || !classId || !type) return res.status(400).json({ error: 'userId, classId, type required' });
  if (!db.users.find(u => u.id === userId)) return res.status(400).json({ error: 'User not found' });
  if (!db.classes.find(c => c.id === classId)) return res.status(400).json({ error: 'Class not found' });

  // For class_teacher, remove existing class_teacher assignment for this class (one class teacher per class)
  if (type === 'class_teacher') {
    db.assignments = db.assignments.filter(a => !(a.classId === classId && a.type === 'class_teacher'));
  }

  const assignment = {
    id: uuid(), userId, classId, type,
    days: days || null, startDate: startDate || null, endDate: endDate || null,
    temporary: temporary || false,
  };
  db.assignments.push(assignment);
  saveDb();
  const userName = db.users.find(u => u.id === userId)?.name;
  const classLabel = db.classes.find(c => c.id === classId)?.label;
  addLog('assignment_add', null, `${userName} → ${classLabel} (${type})`);
  res.status(201).json(assignment);
});

app.delete('/api/assignments/:id', (req, res) => {
  const idx = db.assignments.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Assignment not found' });
  const removed = db.assignments.splice(idx, 1)[0];
  saveDb();
  addLog('assignment_remove', null, `${removed.userId} from ${removed.classId}`);
  res.json({ ok: true });
});

// ======== ENROLLMENT ========

app.post('/api/enrollment-qr/:userId', async (req, res) => {
  const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Invalidate previous unused tokens for this user
  db.enrollmentTokens.forEach(t => { if (t.userId === user.id && !t.used) t.used = true; });

  const token = uuid();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.enrollmentTokens.push({ token, code, userId: user.id, createdAt: new Date().toISOString(), used: false });
  saveDb();

  const serverUrl = getServerUrl(req);
  const qrData = JSON.stringify({ server: serverUrl, token });
  const qrDataUrl = await QRCode.toDataURL(qrData, { width: 300, margin: 2 });
  res.json({ qr: qrDataUrl, token, code, expiresNote: 'One-time use' });
});

app.post('/api/enroll', (req, res) => {
  const { token, code, deviceId } = req.body;
  if ((!token && !code) || !deviceId) return res.status(400).json({ error: 'Token or code, and deviceId required' });

  const entry = token
    ? db.enrollmentTokens.find(t => t.token === token)
    : db.enrollmentTokens.find(t => t.code === code && !t.used);
  if (!entry) return res.status(404).json({ error: 'Invalid or expired code' });
  if (entry.used) return res.status(410).json({ error: 'Code already used' });

  entry.used = true;

  const existing = db.devices.find(d => d.deviceId === deviceId && d.userId === entry.userId);
  if (!existing) {
    db.devices.push({ deviceId, userId: entry.userId, enrolledAt: new Date().toISOString(), revoked: false });
  }
  saveDb();

  const user = db.users.find(u => u.id === entry.userId);
  addLog('enroll', entry.userId, `Device ${deviceId.slice(0, 12)}`);
  res.json({ ok: true, user: sanitizeUser(user) });
});

// ======== DEVICE AUTH ========

app.get('/api/me', (req, res) => {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) return res.status(401).json({ error: 'No device ID' });
  const device = db.devices.find(d => d.deviceId === deviceId);
  if (!device) return res.status(401).json({ error: 'Not enrolled' });
  if (device.revoked) return res.status(403).json({ error: 'revoked' });
  const user = db.users.find(u => u.id === device.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(sanitizeUser(user));
});

// ======== DEVICES ========

app.get('/api/devices', (_req, res) => {
  const enriched = db.devices.map(d => {
    const user = db.users.find(u => u.id === d.userId);
    return { ...d, userName: user?.name, userRole: user?.role };
  });
  res.json(enriched);
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
  const { records } = req.body; // [{ classId, studentId, date, status, markedBy, note }]
  if (!Array.isArray(records)) return res.status(400).json({ error: 'Records array required' });

  // Check locking
  const lockHours = db.settings.lockAfterHours || 0;
  let added = 0, updated = 0, locked = 0;

  for (const r of records) {
    // Check lock
    if (lockHours && isLocked(r.date, lockHours)) { locked++; continue; }

    const idx = db.attendance.findIndex(a =>
      a.classId === r.classId && a.studentId === r.studentId && a.date === r.date
    );

    if (idx >= 0) {
      const existing = db.attendance[idx];
      // ponytail: keep edit history
      if (!existing.history) existing.history = [];
      existing.history.push({
        status: existing.status, changedBy: existing.markedBy,
        changedAt: existing.markedAt, reason: 'update',
      });
      existing.status = r.status || 'present';
      existing.markedBy = r.markedBy;
      existing.markedByRole = r.markedByRole || '';
      existing.markedAt = new Date().toISOString();
      existing.note = r.note || existing.note || '';
      existing.deviceId = r.deviceId || '';
      updated++;
    } else {
      db.attendance.push({
        id: uuid(),
        studentId: r.studentId, classId: r.classId, date: r.date,
        status: r.status || 'present',
        markedBy: r.markedBy, markedByRole: r.markedByRole || '',
        deviceId: r.deviceId || '',
        markedAt: new Date().toISOString(), syncedAt: new Date().toISOString(),
        note: r.note || '', history: [],
      });
      added++;
    }
  }
  saveDb();
  res.json({ ok: true, added, updated, locked, total: records.length });
});

app.get('/api/attendance/:classId/:date', (req, res) => {
  const { classId, date } = req.params;
  const records = db.attendance.filter(a => a.classId === classId && a.date === date);
  res.json(records);
});

app.get('/api/attendance-summary/:classId', (req, res) => {
  const { classId } = req.params;
  const students = db.students.filter(s => s.classId === classId && s.active !== false);
  const records = db.attendance.filter(a => a.classId === classId);
  const dates = [...new Set(records.map(r => r.date))].sort();

  const summary = students.map(s => {
    const sr = records.filter(r => r.studentId === s.id);
    const present = sr.filter(r => r.status === 'present' || r.status === 'late').length;
    const total = sr.length;
    return {
      studentId: s.id, name: s.name, rollNo: s.rollNo,
      present, absent: total - present, total,
      percentage: total ? Math.round((present / total) * 100) : 0,
    };
  });
  res.json({ dates, summary });
});

// ======== CORRECTIONS ========

app.post('/api/corrections', (req, res) => {
  const { attendanceId, newStatus, reason } = req.body;
  if (!attendanceId || !newStatus) return res.status(400).json({ error: 'attendanceId and newStatus required' });
  const att = db.attendance.find(a => a.id === attendanceId);
  if (!att) return res.status(404).json({ error: 'Attendance record not found' });

  const correction = {
    id: uuid(), attendanceId,
    requestedBy: req.headers['x-device-id'] || 'unknown',
    oldStatus: att.status, newStatus,
    reason: reason || '',
    status: 'pending',
    requestedAt: new Date().toISOString(),
    reviewedBy: null, reviewedAt: null,
  };
  db.corrections.push(correction);
  saveDb();
  res.status(201).json(correction);
});

app.get('/api/corrections', (_req, res) => {
  // Enrich with student/class info
  const enriched = db.corrections.map(c => {
    const att = db.attendance.find(a => a.id === c.attendanceId);
    const student = att ? db.students.find(s => s.id === att.studentId) : null;
    const cls = att ? db.classes.find(cl => cl.id === att.classId) : null;
    return {
      ...c,
      studentName: student?.name, classLabel: cls?.label, date: att?.date,
    };
  });
  res.json(enriched);
});

app.post('/api/corrections/:id/approve', (req, res) => {
  const c = db.corrections.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Correction not found' });
  c.status = 'approved';
  c.reviewedBy = 'admin';
  c.reviewedAt = new Date().toISOString();

  // Apply the correction
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
  c.status = 'rejected';
  c.reviewedBy = 'admin';
  c.reviewedAt = new Date().toISOString();
  saveDb();
  res.json(c);
});

// ======== REPORTS ========

app.get('/api/reports/daily/:classId/:date', (req, res) => {
  const { classId, date } = req.params;
  const students = db.students.filter(s => s.classId === classId && s.active !== false).sort((a, b) => a.rollNo - b.rollNo);
  const records = db.attendance.filter(a => a.classId === classId && a.date === date);
  const cls = db.classes.find(c => c.id === classId);

  const rows = students.map(s => {
    const rec = records.find(r => r.studentId === s.id);
    return {
      rollNo: s.rollNo, name: s.name, studentId: s.id,
      status: rec?.status || 'not_marked', note: rec?.note || '',
      markedBy: rec?.markedBy || '', markedAt: rec?.markedAt || '',
    };
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

  const students = db.students.filter(s => s.classId === classId && s.active !== false).sort((a, b) => a.rollNo - b.rollNo);
  const records = db.attendance.filter(a => a.classId === classId && a.date >= start && a.date <= end);
  const dates = [];
  for (let d = new Date(start); d <= new Date(end); d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }

  const rows = students.map(s => {
    const dayStatuses = {};
    for (const date of dates) {
      const rec = records.find(r => r.studentId === s.id && r.date === date);
      dayStatuses[date] = rec?.status || '-';
    }
    const sr = records.filter(r => r.studentId === s.id);
    const present = sr.filter(r => r.status === 'present' || r.status === 'late').length;
    return { rollNo: s.rollNo, name: s.name, days: dayStatuses, present, total: sr.length };
  });

  res.json({ classLabel: db.classes.find(c => c.id === classId)?.label, dates, rows });
});

app.get('/api/reports/monthly/:classId/:month', (req, res) => {
  const { classId, month } = req.params; // month = "2025-06"
  const students = db.students.filter(s => s.classId === classId && s.active !== false).sort((a, b) => a.rollNo - b.rollNo);
  const records = db.attendance.filter(a => a.classId === classId && a.date.startsWith(month));

  const rows = students.map(s => {
    const sr = records.filter(r => r.studentId === s.id);
    const present = sr.filter(r => r.status === 'present' || r.status === 'late').length;
    const absent = sr.filter(r => r.status === 'absent').length;
    const leave = sr.filter(r => r.status === 'leave').length;
    return {
      rollNo: s.rollNo, name: s.name, studentId: s.id,
      present, absent, leave, total: sr.length,
      percentage: sr.length ? Math.round((present / sr.length) * 100) : 0,
    };
  });

  res.json({ classLabel: db.classes.find(c => c.id === classId)?.label, month, rows });
});

app.get('/api/reports/student/:studentId', (req, res) => {
  const student = db.students.find(s => s.id === req.params.studentId);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const records = db.attendance.filter(a => a.studentId === student.id).sort((a, b) => a.date.localeCompare(b.date));
  const present = records.filter(r => r.status === 'present' || r.status === 'late').length;
  const cls = db.classes.find(c => c.id === student.classId);
  res.json({
    student: { ...student, classLabel: cls?.label },
    records,
    summary: { present, absent: records.length - present, total: records.length, percentage: records.length ? Math.round((present / records.length) * 100) : 0 },
  });
});

app.get('/api/reports/absentees/:date', (req, res) => {
  const { date } = req.params;
  const absentees = [];
  for (const cls of db.classes) {
    const students = db.students.filter(s => s.classId === cls.id && s.active !== false);
    for (const s of students) {
      const rec = db.attendance.find(a => a.studentId === s.id && a.date === date);
      if (rec && rec.status === 'absent') {
        absentees.push({ classLabel: cls.label, rollNo: s.rollNo, name: s.name, studentId: s.id });
      }
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

// CSV export
app.get('/api/reports/export/:classId/:type', (req, res) => {
  const { classId, type } = req.params;
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

// ======== BACKUP ========

app.get('/api/backup/download', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=attendance-backup-${new Date().toISOString().slice(0, 10)}.json`);
  res.send(JSON.stringify(db, null, 2));
});

app.post('/api/backup/restore', (req, res) => {
  const data = req.body;
  // Basic validation
  if (!data.settings || !data.users || !data.classes) {
    return res.status(400).json({ error: 'Invalid backup file. Must contain settings, users, and classes.' });
  }
  // Create backup of current state before restore
  createBackup();
  db = data;
  // Ensure all arrays exist
  db.students = db.students || [];
  db.assignments = db.assignments || [];
  db.devices = db.devices || [];
  db.enrollmentTokens = db.enrollmentTokens || [];
  db.attendance = db.attendance || [];
  db.corrections = db.corrections || [];
  db.log = db.log || [];
  saveDb();
  addLog('restore', null, 'Database restored from backup');
  res.json({ ok: true, users: db.users.length, students: db.students.length, classes: db.classes.length });
});

app.get('/api/backup/list', (_req, res) => {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort().reverse();
  const list = files.map(f => {
    const stat = fs.statSync(path.join(BACKUP_DIR, f));
    return { name: f, size: stat.size, date: stat.mtime.toISOString() };
  });
  res.json(list);
});

app.get('/api/backup/status', (_req, res) => {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort();
  const last = files.length ? files[files.length - 1] : null;
  const lastDate = last ? fs.statSync(path.join(BACKUP_DIR, last)).mtime.toISOString() : null;
  res.json({ lastBackup: lastDate, backupCount: files.length, backupDir: BACKUP_DIR });
});

// ======== HELPERS ========

function sanitizeUser(user) {
  if (!user) return null;
  // ponytail: include assignments for this user
  const assignments = db.assignments.filter(a => a.userId === user.id);
  return { id: user.id, name: user.name, role: user.role, active: user.active, assignments };
}

function getServerUrl(req) {
  if (global.TUNNEL_URL) return global.TUNNEL_URL;
  const host = req.headers.host || `localhost:${PORT}`;
  return `${req.protocol}://${host}`;
}

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
    }
  }
  return 'localhost';
}

function isLocked(date, lockHours) {
  if (!lockHours) return false;
  const endOfDay = new Date(date + 'T23:59:59');
  const lockTime = new Date(endOfDay.getTime() + lockHours * 3600000);
  return new Date() > lockTime;
}

// ======== START ========

// ponytail: first-run check
if (!db) {
  console.log('\n  First run! No db.json found.');
  console.log('  Open http://localhost:' + PORT + '/admin to set up.');
  console.log('  Or run: npm run seed\n');
  // Create minimal empty db so server doesn't crash
  db = {
    settings: { setupDone: false }, users: [], classes: [], students: [],
    assignments: [], devices: [], enrollmentTokens: [], attendance: [],
    corrections: [], log: [],
  };
}

// Auto backup on start
if (db.settings?.setupDone) createBackup();

// Daily auto backup (every 24h)
setInterval(() => { if (db.settings?.setupDone) createBackup(); }, 24 * 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', async () => {
  const lanIp = getLanIp();
  console.log(`Server running at http://${lanIp}:${PORT}`);
  
  try {
    const tunnel = await localtunnel({ port: PORT, subdomain: 'vyas-school-att-' + Math.floor(Math.random()*10000) });
    global.TUNNEL_URL = tunnel.url;
    console.log(`\nPublic URL (Remote Access): ${tunnel.url}\n`);
    
    tunnel.on('close', () => {
      console.log('Tunnel closed');
    });
  } catch (err) {
    console.error('Failed to create tunnel:', err.message);
  }

  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${lanIp}:${PORT}`);
  console.log(`  Admin:   http://localhost:${PORT}/admin`);
  console.log(`  App:     http://localhost:${PORT}/app`);
  if (db.settings?.setupDone) {
    console.log(`\n  ${db.settings.schoolName}`);
    console.log(`  Users: ${db.users.length} | Classes: ${db.classes.length} | Students: ${db.students.length}`);
  }
});
