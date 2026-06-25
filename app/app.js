// ponytail: all teacher PWA logic — install gate, pairing, attendance, sync, reports
(function () {
  'use strict';

  // --- Install gate ---
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches
                   || window.navigator.standalone === true;
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });

  window.triggerInstall = function () {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
    } else {
      document.getElementById('manualSteps').classList.remove('hidden');
      document.getElementById('btnInstall').textContent = 'Follow the steps below';
    }
  };

  if (!isInstalled) {
    document.getElementById('installGate').classList.remove('hidden');
    document.getElementById('realApp')?.classList.add('hidden');
    lucide.createIcons();
    return; // ponytail: stop here, don't run app logic
  }

  // --- Show real app ---
  document.getElementById('installGate').classList.add('hidden');
  document.getElementById('realApp').classList.remove('hidden');

  // --- State ---
  const LS = {
    get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
    del: (k) => localStorage.removeItem(k),
  };

  let pairing = ATT.pairing.get(); // { server, deviceId, deviceToken, user, role }
  let connectionState = 'offline';
  let students = [];
  let attendance = {}; // { [studentId]: { status, note } }
  let currentClassId = null;
  let myAssignments = [];

  // --- Init ---
  function init() {
    registerSW();
    if (!pairing) {
      setState('not-paired');
      showScreen('scan');
    } else {
      setState('connecting');
      checkConnection();
    }
    setInterval(() => {
      if (pairing && connectionState !== 'revoked') syncPending();
    }, 30000);
    const dateInput = document.getElementById('attDate');
    if (dateInput) {
      dateInput.value = today();
      dateInput.addEventListener('change', loadAttendanceForDate);
    }
    document.getElementById('todayDate').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    lucide.createIcons();
  }

  function registerSW() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  // --- Screens ---
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + name)?.classList.add('active');
    document.getElementById('bottomNav')?.classList.toggle('hidden', name !== 'home');
  }
  window.showScreen = showScreen;

  // --- Pages (within home screen) ---
  window.showPage = function (name, btn) {
    ['home', 'mark', 'reports', 'students', 'info'].forEach(p => {
      document.getElementById('page-' + p)?.classList.add('hidden');
    });
    document.getElementById('page-' + name)?.classList.remove('hidden');
    document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (name === 'mark') loadAttendanceForDate();
    if (name === 'reports') loadReview();
    if (name === 'students') loadStudentRoster();
    if (name === 'info') updatePendingCount();
  };

  // --- Connection state ---
  function setState(state) {
    connectionState = state;
    const dot = document.getElementById('statusDot');
    const footer = document.getElementById('footerStatus');
    const labels = {
      'not-paired': ['status-offline', 'Not paired'],
      'connecting': ['status-connecting', 'Connecting...'],
      'connected': ['status-connected', 'Connected'],
      'offline': ['status-offline', 'Saved on this device'],
      'sync-pending': ['status-connecting', 'Sync pending...'],
      'revoked': ['status-revoked', 'Device revoked'],
    };
    const [cls, label] = labels[state] || ['status-offline', state];
    dot.className = 'status-dot ' + cls;
    dot.title = label;
    footer.textContent = label;

    const banner = document.getElementById('statusBanner');
    if (banner) {
      if (state === 'offline' || state === 'sync-pending') {
        banner.className = 'status-banner ' + (state === 'sync-pending' ? 'syncing' : 'offline');
        banner.textContent = label;
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
      }
    }
  }

  // --- API helper (routes through the shared transport: WebRTC → REST → error) ---
  async function api(path, opts = {}) {
    try {
      return await ATT.conn.request('/api' + path, {
        method: opts.method || 'GET',
        body: opts.body ? JSON.parse(opts.body) : undefined,
      });
    } catch (e) {
      if (e.revoked) { setState('revoked'); showScreen('revoked'); throw new Error('revoked'); }
      throw e;
    }
  }

  // --- Auto-reconnect ---
  async function checkConnection() {
    await ATT.pairing.reconnect();
    try {
      const user = await api('/me');
      if (user.iceServers) ATT.ICE = user.iceServers; // upgrade ICE (TURN) for paired device
      pairing.user = user;
      ATT.pairing.save(pairing);
      setState('connected');
      try { myAssignments = await api('/my-assignments'); } catch { myAssignments = pairing.user?.assignments || []; }
      try { LS.set('settings', await api('/settings')); } catch {}
      try { LS.set('holidays', await api('/holidays')); } catch {}
      setupHomeScreen(user);
    } catch (e) {
      if (e.message === 'revoked') return;
      setState('offline');
      myAssignments = pairing.user?.assignments || [];
      if (pairing.user) setupHomeScreen(pairing.user);
    }
  }

  // --- QR Scanning ---
  let scanning = false, scanStream = null;

  window.startScan = async function () {
    const video = document.getElementById('scanVideo');
    const btn = document.getElementById('btnStartScan');
    if (scanning) { stopScan(); return; }
    if (!('BarcodeDetector' in window)) {
      document.getElementById('scanStatus').textContent = 'Camera QR not supported. Use pairing code below.';
      return;
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = scanStream;
      video.classList.remove('hidden');
      btn.innerHTML = '<i data-lucide="x" style="width:18px;height:18px"></i> Stop';
      lucide.createIcons();
      scanning = true;
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      detectLoop(video, detector);
    } catch (e) {
      document.getElementById('scanStatus').textContent = 'Camera error: ' + e.message;
    }
  };

  async function detectLoop(video, detector) {
    if (!scanning) return;
    try {
      const barcodes = await detector.detect(video);
      if (barcodes.length > 0) { stopScan(); await processQR(barcodes[0].rawValue); return; }
    } catch {}
    requestAnimationFrame(() => detectLoop(video, detector));
  }

  function stopScan() {
    scanning = false;
    document.getElementById('scanVideo').classList.add('hidden');
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    document.getElementById('btnStartScan').innerHTML = '<i data-lucide="camera" style="width:18px;height:18px"></i> Scan QR Code';
    lucide.createIcons();
  }

  window.manualEnroll = async function () {
    const code = document.getElementById('manualCode').value.trim();
    const statusEl = document.getElementById('scanStatus');
    if (!code || code.length !== 6) { statusEl.textContent = 'Enter the 6-digit code'; return; }
    statusEl.textContent = 'Pairing…';
    statusEl.style.color = 'var(--yellow)';
    try {
      // Served locally → pair over same-origin; remote → over the public server (tunnel/WebRTC).
      pairing = await ATT.pairing.enroll({ code, expectApp: 'teacher', server: ATT.isLocalServed() ? location.origin : undefined });
      await afterPair();
    } catch (e) { statusEl.textContent = e.message || 'Pairing failed'; statusEl.style.color = 'var(--red)'; }
  };

  async function afterPair() {
    setState('connected');
    try { const me = await api('/me'); if (me.iceServers) ATT.ICE = me.iceServers; } catch {}
    try { myAssignments = await api('/my-assignments'); } catch { myAssignments = pairing.user?.assignments || []; }
    try { const settings = await api('/settings'); LS.set('settings', settings); } catch {}
    try { LS.set('holidays', await api('/holidays')); } catch {}
    setupHomeScreen(pairing.user);
  }

  async function processQR(raw) {
    const statusEl = document.getElementById('scanStatus');
    const inv = ATT.pairing.parseQR(raw);
    if (!inv) { statusEl.textContent = 'This QR is not valid. Ask admin to generate a new code.'; statusEl.style.color = 'var(--red)'; return; }
    statusEl.textContent = 'Pairing…';
    statusEl.style.color = 'var(--yellow)';
    try {
      pairing = await ATT.pairing.enroll({ server: inv.server, token: inv.token, expectApp: 'teacher' });
      await afterPair();
    } catch (e) { statusEl.textContent = e.message || 'Pairing failed'; statusEl.style.color = 'var(--red)'; }
  }

  // --- Home screen setup ---
  function setupHomeScreen(user) {
    showScreen('home');
    document.getElementById('welcomeMsg').textContent = `Welcome, ${user.name}`;
    document.getElementById('infoRole').textContent = user.role.replace(/_/g, ' ');
    document.getElementById('infoServer').textContent = pairing.server;

    // Determine class & assignment selection
    currentClassId = null;
    const selectorContainer = document.getElementById('assignmentSelectorContainer');
    const selector = document.getElementById('assignmentSelector');
    const classNameText = document.getElementById('className');

    if (myAssignments.length > 1) {
      selectorContainer.classList.remove('hidden');
      classNameText.classList.add('hidden');
      selector.innerHTML = myAssignments.map((a, idx) => 
        `<option value="${idx}">${a.classLabel || a.classId} (${a.type === 'class_teacher' ? 'Class' : 'Subject'})</option>`
      ).join('');
      changeAssignment(0);
    } else {
      selectorContainer.classList.add('hidden');
      classNameText.classList.remove('hidden');
      if (myAssignments.length === 1) {
        currentClassId = myAssignments[0].classId;
        const label = myAssignments[0].classLabel || currentClassId;
        classNameText.textContent = 'Class ' + label;
        loadClassData(currentClassId);
      } else {
        classNameText.textContent = 'No class assigned';
      }
    }

    // Show/hide nav items based on role
    const isSubject = user.role === 'subject_teacher';
    document.getElementById('navReports').classList.toggle('hidden', isSubject);
    document.getElementById('navStudents').classList.toggle('hidden', isSubject);

    // Build home quick actions
    buildHomeActions(user);
    showPage('home', document.querySelector('.bottom-nav button'));
  }

  window.changeAssignment = function(index) {
    const idx = parseInt(index);
    const assignment = myAssignments[idx];
    if (!assignment) return;
    currentClassId = assignment.classId;
    loadClassData(currentClassId);
    // Reload active tab data if applicable
    const activeBtn = document.querySelector('.bottom-nav button.active');
    if (activeBtn) {
      const activeText = activeBtn.textContent.trim().toLowerCase();
      if (activeText.includes('attendance')) loadAttendanceForDate();
      if (activeText.includes('reports')) changeTeacherReport();
      if (activeText.includes('students')) loadStudentRoster();
    }
  };

  function buildHomeActions(user) {
    const el = document.getElementById('homeActions');
    let html = `
      <div class="action-card" onclick="showPage('mark',document.querySelectorAll('.bottom-nav button')[1])">
        <i data-lucide="check-square" style="width:28px;height:28px"></i>
        <span>Mark Attendance</span>
      </div>`;
    if (user.role !== 'subject_teacher') {
      html += `
      <div class="action-card" onclick="showPage('reports',document.querySelectorAll('.bottom-nav button')[2])">
        <i data-lucide="bar-chart-3" style="width:28px;height:28px"></i>
        <span>Reports</span>
      </div>
      <div class="action-card" onclick="showPage('students',document.querySelectorAll('.bottom-nav button')[3])">
        <i data-lucide="users" style="width:28px;height:28px"></i>
        <span>Students</span>
      </div>`;
    }
    html += `
      <div class="action-card" onclick="showPage('info',document.querySelectorAll('.bottom-nav button')[4])">
        <i data-lucide="settings" style="width:28px;height:28px"></i>
        <span>Settings</span>
      </div>`;
    el.innerHTML = html;
    lucide.createIcons();
  }

  async function loadClassData(classId) {
    try {
      students = await api('/students/' + classId);
      LS.set('students_' + classId, students);
    } catch {
      students = LS.get('students_' + classId) || [];
    }
  }

  // --- Attendance checking helpers ---
  function isDateLocked(dateStr) {
    const settings = LS.get('settings') || { lockAfterHours: 24 };
    const lockHours = settings.lockAfterHours;
    if (!lockHours) return false;
    const endOfDay = new Date(dateStr + 'T23:59:59');
    const lockTime = new Date(endOfDay.getTime() + lockHours * 3600000);
    return new Date() > lockTime;
  }

  function getActiveAssignment() {
    const selectorContainer = document.getElementById('assignmentSelectorContainer');
    const selector = document.getElementById('assignmentSelector');
    if (selectorContainer && !selectorContainer.classList.contains('hidden') && selector) {
      return myAssignments[parseInt(selector.value)] || null;
    }
    return myAssignments[0] || null;
  }

  function checkAssignmentPermitted(assignment, dateStr) {
    if (!assignment) return { permitted: false, reason: 'No active assignment' };
    
    const parts = dateStr.split('-');
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    const dayName = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getDay()];
    
    // Check temporary date range
    if (assignment.temporary) {
      if (assignment.startDate && dateStr < assignment.startDate) {
        return { permitted: false, reason: `Assignment only starts from ${assignment.startDate}` };
      }
      if (assignment.endDate && dateStr > assignment.endDate) {
        return { permitted: false, reason: `Assignment ended on ${assignment.endDate}` };
      }
    }
    
    // Check day name restriction
    if (assignment.days && assignment.days.length > 0) {
      if (!assignment.days.includes(dayName)) {
        return { permitted: false, reason: `Only assigned on ${assignment.days.join(', ').toUpperCase()}` };
      }
    }
    
    return { permitted: true };
  }

  // --- Attendance marking ---
  async function loadAttendanceForDate() {
    const date = document.getElementById('attDate').value;
    if (!currentClassId || !date) return;

    const blockMsg = document.getElementById('blockMessage');
    const list = document.getElementById('studentList');
    const btnAll = document.getElementById('btnAllPresent');
    const btnSave = document.getElementById('btnSaveAttendance');

    blockMsg.classList.add('hidden');
    list.classList.remove('hidden');
    btnAll.classList.remove('hidden');
    btnSave.classList.remove('hidden');

    const assignment = getActiveAssignment();
    const check = checkAssignmentPermitted(assignment, date);
    if (!check.permitted) {
      blockMsg.textContent = `Blocked: ${check.reason}`;
      blockMsg.style.background = 'rgba(239, 68, 68, 0.1)';
      blockMsg.style.borderColor = 'var(--red)';
      blockMsg.style.color = 'var(--red)';
      blockMsg.classList.remove('hidden');
      list.classList.add('hidden');
      btnAll.classList.add('hidden');
      btnSave.classList.add('hidden');
      return;
    }

    const locked = isDateLocked(date);

    // Holiday warning — informative, does not block marking (edge 85)
    const holiday = (LS.get('holidays') || []).find(h => h.date === date);
    if (holiday && !locked) {
      blockMsg.textContent = `Note: ${date} is a holiday (${holiday.name}). Mark attendance only if school was open.`;
      blockMsg.style.background = 'rgba(234, 179, 8, 0.1)';
      blockMsg.style.borderColor = 'var(--yellow)';
      blockMsg.style.color = 'var(--yellow)';
      blockMsg.classList.remove('hidden');
    }

    if (locked) {
      blockMsg.textContent = 'Attendance is locked. To correct attendance, use the "Request Correction" button next to a student.';
      blockMsg.style.background = 'rgba(234, 179, 8, 0.1)';
      blockMsg.style.borderColor = 'var(--yellow)';
      blockMsg.style.color = 'var(--yellow)';
      blockMsg.classList.remove('hidden');
      btnAll.classList.add('hidden');
      btnSave.classList.add('hidden');
    }

    const localKey = `att_${currentClassId}_${date}`;
    const localAtt = LS.get(localKey) || {};

    try {
      const serverAtt = await api(`/attendance/${currentClassId}/${date}`);
      attendance = {};
      for (const r of serverAtt) attendance[r.studentId] = { id: r.id, status: r.status, note: r.note || '' };
      for (const [sid, data] of Object.entries(localAtt)) {
        attendance[sid] = {
          id: attendance[sid]?.id || null,
          status: data.status,
          note: data.note || ''
        };
      }
    } catch {
      attendance = {};
      for (const [sid, data] of Object.entries(localAtt)) {
        attendance[sid] = { id: null, status: data.status, note: data.note || '' };
      }
    }
    renderStudents(locked);
  }

  function renderStudents(locked = false) {
    const list = document.getElementById('studentList');
    if (!students.length) {
      list.innerHTML = '<p style="padding:16px;color:var(--muted)">No students found</p>';
      return;
    }

    if (locked) {
      list.innerHTML = students.map(s => {
        const att = attendance[s.id] || { id: null, status: 'absent', note: '' };
        const badge = att.status === 'present' ? 'badge-green' : att.status === 'absent' ? 'badge-red' : att.status === 'late' ? 'badge-yellow' : att.status === 'leave' ? 'badge-blue' : '';
        return `<div class="student-row" style="flex-wrap:wrap">
          <div style="display:flex;align-items:center;width:100%;justify-content:space-between">
            <span class="student-roll">${s.rollNo}</span>
            <span class="student-name" style="flex:1;margin-left:8px">${s.name}</span>
            <span class="badge ${badge}" style="margin-right:8px">${att.status.toUpperCase()}</span>
            ${att.id ? `<button class="btn-sm btn-outline" style="font-size:0.75rem;padding:4px 8px;min-height:28px" onclick="requestCorrection('${att.id}','${s.id}','${s.name.replace(/'/g, "\\'")}')">Request Correction</button>` : `<span style="color:var(--muted);font-size:0.75rem">No saved record</span>`}
          </div>
          ${att.note ? `<div style="font-size:0.75rem;color:var(--muted);width:100%;margin-top:4px;padding-left:32px">Note: ${att.note}</div>` : ''}
        </div>`;
      }).join('');
    } else {
      list.innerHTML = students.map(s => {
        const att = attendance[s.id] || { status: 'absent', note: '' };
        return `<div class="student-row" style="flex-wrap:wrap">
          <div style="display:flex;align-items:center;width:100%;justify-content:space-between">
            <span class="student-roll">${s.rollNo}</span>
            <span class="student-name" style="flex:1;margin-left:8px">${s.name}</span>
            <button class="att-btn att-P ${att.status === 'present' ? 'sel' : ''}" onclick="setAtt('${s.id}','present')">P</button>
            <button class="att-btn att-A ${att.status === 'absent' ? 'sel' : ''}" onclick="setAtt('${s.id}','absent')">A</button>
            <button class="att-btn att-L ${att.status === 'late' ? 'sel' : ''}" onclick="setAtt('${s.id}','late')">L</button>
            <button class="att-btn att-V ${att.status === 'leave' ? 'sel' : ''}" onclick="setAtt('${s.id}','leave')">V</button>
          </div>
          <div style="width:100%;margin-top:4px;padding:0 8px">
            <input type="text" placeholder="Add note (optional)" value="${att.note || ''}" onchange="setNote('${s.id}',this.value)" style="width:100%;margin:0;font-size:0.8rem;padding:4px 8px;border:1px solid #2d3748;border-radius:4px;background:#1a202c;color:white">
          </div>
        </div>`;
      }).join('');
    }
  }

  window.setAtt = function (studentId, status) {
    const existing = attendance[studentId] || {};
    attendance[studentId] = { ...existing, status };
    renderStudents();
  };

  window.setNote = function (studentId, note) {
    const existing = attendance[studentId] || {};
    attendance[studentId] = { ...existing, note };
  };

  window.markAllPresent = function () {
    for (const s of students) {
      attendance[s.id] = { status: 'present', note: attendance[s.id]?.note || '' };
    }
    renderStudents();
  };

  window.saveAttendance = async function () {
    const date = document.getElementById('attDate').value;
    if (!currentClassId || !date) return;

    // Unusual-pattern guard: confirm if everyone is marked absent (edge 80)
    const marked = students.map(s => attendance[s.id]?.status || 'absent');
    if (marked.length && marked.every(st => st === 'absent')) {
      if (!confirm('All students are marked Absent. Is that correct?')) return;
    }

    // Stamp a fresh op-id per record for this save: retries of THIS save dedupe on the
    // server; a later edit gets new ids and syncs as an update (idempotency, edges 47-48).
    for (const sid in attendance) attendance[sid].opId = ATT.genId();

    const localKey = `att_${currentClassId}_${date}`;
    LS.set(localKey, attendance);

    const pendingKey = 'pending_syncs';
    const pending = LS.get(pendingKey) || [];
    if (!pending.includes(localKey)) pending.push(localKey);
    LS.set(pendingKey, pending);

    await syncPending();
    updatePendingCount();

    // ponytail: simple success feedback
    const btn = event.currentTarget;
    const orig = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="check" style="width:16px;height:16px"></i> Saved!';
    btn.style.background = 'var(--green)';
    lucide.createIcons();
    setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; lucide.createIcons(); }, 2000);
  };

  window.requestCorrection = async function (attId, studentId, studentName) {
    if (!attId) {
      alert('Cannot request correction: no attendance record exists for this student on this date.');
      return;
    }
    const newStatusChar = prompt(`Enter new status for ${studentName}\n(P = Present, A = Absent, L = Late, V = Leave):`);
    if (!newStatusChar) return;
    const statusMap = { p: 'present', a: 'absent', l: 'late', v: 'leave' };
    const status = statusMap[newStatusChar.trim().toLowerCase()];
    if (!status) {
      alert('Invalid status. Use P, A, L, or V.');
      return;
    }
    const reason = prompt(`Enter reason for correction request:`);
    if (!reason || !reason.trim()) {
      alert('Reason is required to submit a correction request.');
      return;
    }

    if (connectionState === 'offline') {
      const pending = LS.get('pending_corrections') || [];
      pending.push({ attendanceId: attId, newStatus: status, reason: reason.trim() });
      LS.set('pending_corrections', pending);
      alert('Offline: Correction request queued and will sync when connected.');
      updatePendingCount();
      return;
    }

    try {
      await api('/corrections', {
        method: 'POST',
        body: JSON.stringify({ attendanceId: attId, newStatus: status, reason: reason.trim() })
      });
      alert('Correction request submitted to Administrator.');
      loadAttendanceForDate();
    } catch (e) {
      alert('Failed to submit request: ' + e.message);
    }
  };

  // --- Sync ---
  async function syncPending() {
    const pending = LS.get('pending_syncs') || [];
    const pendingCorr = LS.get('pending_corrections') || [];
    if (!pending.length && !pendingCorr.length) return;
    setState('sync-pending');
    
    // Sync attendance records
    const remaining = [];
    for (const key of pending) {
      const parts = key.split('_');
      const date = parts.pop();
      const classId = parts.slice(1).join('_');
      const attData = LS.get(key);
      if (!attData) continue;

      const records = Object.entries(attData).map(([studentId, data]) => ({
        classId, studentId, date,
        status: data.status || 'present',
        note: data.note || '',
        opId: data.opId,
        markedBy: pairing.user?.id,
        markedByRole: pairing.user?.role,
        deviceId: pairing.deviceId,
      }));

      try {
        await api('/attendance', { method: 'POST', body: JSON.stringify({ records }) });
        LS.del(key);
      } catch { remaining.push(key); }
    }
    LS.set('pending_syncs', remaining);

    // Sync corrections
    const remainingCorr = [];
    for (const item of pendingCorr) {
      try {
        await api('/corrections', { method: 'POST', body: JSON.stringify(item) });
      } catch { remainingCorr.push(item); }
    }
    LS.set('pending_corrections', remainingCorr);

    setState((remaining.length || remainingCorr.length) ? 'sync-pending' : 'connected');
    updatePendingCount();
  }

  function updatePendingCount() {
    const pending = LS.get('pending_syncs') || [];
    const pendingCorr = LS.get('pending_corrections') || [];
    const totalPending = pending.length + pendingCorr.length;
    const el = document.getElementById('infoPending');
    if (el) el.textContent = totalPending;
  }

  // --- Review/Reports ---
  window.changeTeacherReport = function() {
    const type = document.getElementById('teacherReportType').value;
    const dateInput = document.getElementById('teacherReportDate');
    const monthInput = document.getElementById('teacherReportMonth');

    dateInput.classList.add('hidden');
    monthInput.classList.add('hidden');

    if (type === 'daily' || type === 'weekly') {
      dateInput.classList.remove('hidden');
      if (!dateInput.value) dateInput.value = today();
    } else if (type === 'monthly') {
      monthInput.classList.remove('hidden');
      if (!monthInput.value) monthInput.value = today().slice(0, 7); // YYYY-MM
    }

    loadReportData();
  };

  async function loadReportData() {
    if (!currentClassId) return;
    const type = document.getElementById('teacherReportType').value;
    const date = document.getElementById('teacherReportDate').value;
    const month = document.getElementById('teacherReportMonth').value;
    const el = document.getElementById('summaryTable');

    el.innerHTML = '<p style="color:var(--muted)">Loading report...</p>';

    try {
      if (type === 'summary') {
        const data = await api('/attendance-summary/' + currentClassId);
        if (!data.summary.length) { el.innerHTML = '<p style="color:var(--muted)">No attendance data yet</p>'; return; }
        el.innerHTML = `<table>
          <thead><tr><th>#</th><th>Name</th><th>P</th><th>A</th><th>%</th></tr></thead>
          <tbody>${data.summary.map(s => `<tr>
            <td>${s.rollNo}</td>
            <td>${s.name}</td>
            <td><span class="badge badge-green">${s.present}</span></td>
            <td><span class="badge badge-red">${s.absent}</span></td>
            <td>${s.percentage}%</td>
          </tr>`).join('')}</tbody>
        </table>`;
      } else if (type === 'daily') {
        const data = await api(`/reports/daily/${currentClassId}/${date}`);
        if (!data.rows.length) { el.innerHTML = '<p style="color:var(--muted)">No records found</p>'; return; }
        el.innerHTML = `
          <div class="card mb-8" style="background:#1a1d27;padding:12px;font-size:0.8rem">
            Present: <strong style="color:var(--green)">${data.stats.present}</strong> |
            Absent: <strong style="color:var(--red)">${data.stats.absent}</strong> |
            Late: <strong style="color:var(--yellow)">${data.stats.late}</strong> |
            Leave: <strong style="color:var(--blue)">${data.stats.leave}</strong>
          </div>
          <table>
            <thead><tr><th>#</th><th>Name</th><th>Status</th><th>Note</th></tr></thead>
            <tbody>${data.rows.map(r => {
              const badge = r.status === 'present' ? 'badge-green' : r.status === 'absent' ? 'badge-red' : r.status === 'late' ? 'badge-yellow' : r.status === 'leave' ? 'badge-blue' : 'badge-muted';
              const displayStatus = r.status === 'not_marked' ? 'Not Marked' : r.status.toUpperCase();
              return `<tr>
                <td>${r.rollNo}</td>
                <td>${r.name}</td>
                <td><span class="badge ${badge}">${displayStatus}</span></td>
                <td style="font-size:0.75rem;color:var(--muted)">${r.note || ''}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>`;
      } else if (type === 'weekly') {
        const dateObj = new Date(date);
        const day = dateObj.getDay();
        const diffToMon = dateObj.getDate() - day + (day === 0 ? -6 : 1);
        const mon = new Date(dateObj.setDate(diffToMon)).toISOString().slice(0, 10);
        const sun = new Date(dateObj.setDate(diffToMon + 6)).toISOString().slice(0, 10);

        const data = await api(`/reports/weekly/${currentClassId}?start=${mon}&end=${sun}`);
        if (!data.rows.length) { el.innerHTML = '<p style="color:var(--muted)">No records</p>'; return; }

        const headers = data.dates.map(d => {
          const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(d).getDay()];
          const dayNum = d.split('-')[2];
          return `<th style="text-align:center;font-size:0.7rem;padding:4px">${dayName}<br>${dayNum}</th>`;
        }).join('');

        el.innerHTML = `<table>
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              ${headers}
              <th style="text-align:center">P/Tot</th>
            </tr>
          </thead>
          <tbody>${data.rows.map(r => {
            const dayCells = data.dates.map(d => {
              const st = r.days[d] || '-';
              let char = '-';
              let color = 'var(--muted)';
              if (st === 'present') { char = 'P'; color = 'var(--green)'; }
              else if (st === 'absent') { char = 'A'; color = 'var(--red)'; }
              else if (st === 'late') { char = 'L'; color = 'var(--yellow)'; }
              else if (st === 'leave') { char = 'V'; color = 'var(--blue)'; }
              return `<td style="text-align:center;color:${color};font-weight:bold;padding:4px">${char}</td>`;
            }).join('');
            return `<tr>
              <td>${r.rollNo}</td>
              <td style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100px">${r.name}</td>
              ${dayCells}
              <td style="text-align:center">${r.present}/${r.total}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`;
      } else if (type === 'monthly') {
        const data = await api(`/reports/monthly/${currentClassId}/${month}`);
        if (!data.rows.length) { el.innerHTML = '<p style="color:var(--muted)">No records</p>'; return; }
        el.innerHTML = `<table>
          <thead><tr><th>#</th><th>Name</th><th>P</th><th>A</th><th>L/V</th><th>%</th></tr></thead>
          <tbody>${data.rows.map(r => `<tr>
            <td>${r.rollNo}</td>
            <td>${r.name}</td>
            <td><span class="badge badge-green">${r.present}</span></td>
            <td><span class="badge badge-red">${r.absent}</span></td>
            <td><span class="badge badge-blue">${r.leave}</span></td>
            <td><strong>${r.percentage}%</strong></td>
          </tr>`).join('')}</tbody>
        </table>`;
      }
    } catch (e) {
      el.innerHTML = `<p style="color:var(--muted)">Offline or error loading report</p>`;
    }
  }

  // --- Student Roster ---
  async function loadStudentRoster() {
    if (!currentClassId) return;
    const el = document.getElementById('studentRoster');
    el.innerHTML = '<p style="color:var(--muted)">Loading...</p>';
    try {
      const list = await api('/students/' + currentClassId);
      el.innerHTML = `<table>
        <thead><tr><th>#</th><th>Name</th></tr></thead>
        <tbody>${list.map(s => `<tr><td>${s.rollNo}</td><td>${s.name}</td></tr>`).join('')}</tbody>
      </table>`;
    } catch {
      el.innerHTML = '<p style="color:var(--muted)">Offline</p>';
    }
  }

  // --- Unpair ---
  window.unpair = function () {
    if (!confirm('Clear pairing? You will need a new QR code to re-enroll.')) return;
    ATT.pairing.clear();
    LS.del('pending_syncs');
    LS.del('pending_corrections');
    pairing = null;
    setState('not-paired');
    showScreen('scan');
  };

  // --- Boot ---
  init();
})();
