// ponytail: ONE transport for both apps. WebRTC DataChannel first (the requested pipeline),
// REST-over-tunnel fallback, with timeouts + non-JSON/tunnel-warning detection. Offline is
// handled by callers (local-save + queue). Attaches window.ATT.conn.
(function () {
  const ATT = (window.ATT = window.ATT || {});

  let serverUrl = null;      // base http(s) origin of the server (no trailing slash, no /api)
  let deviceToken = null;
  let pc = null, dc = null, ws = null, dcReady = false;
  let mode = 'rest';         // 'webrtc' | 'rest'
  const pending = new Map(); // requestId -> { resolve, reject, timer }

  function setEndpoint(url, token) {
    serverUrl = (url || '').replace(/\/+$/, '');
    deviceToken = token || null;
  }
  function getMode() { return dcReady ? 'webrtc' : mode; }

  function wsUrl() { return serverUrl.replace(/^http/, 'ws') + '/signal'; }

  // Bring up the WebRTC pipeline. Resolves true if the DataChannel opens, false otherwise.
  // Failure is non-fatal — request() transparently uses REST.
  function connectWebRTC(serverPeerId, timeoutMs) {
    if (typeof serverPeerId === 'number') {
      timeoutMs = serverPeerId;
      serverPeerId = 'vyas-school-att';
    }
    serverPeerId = serverPeerId || 'vyas-school-att';
    timeoutMs = timeoutMs || 8000;
    teardown();
    if (!('RTCPeerConnection' in window)) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const clientId = 'att-client-' + Math.random().toString(36).slice(2, 10);
        const token = Math.random().toString(36).slice(2, 10);
        const signalingUrl = 'wss://0.peerjs.com/peerjs?key=peerjs&id=' + clientId + '&token=' + token + '&version=1.4.7';

        ws = new WebSocket(signalingUrl);
        pc = new RTCPeerConnection({ iceServers: ATT.ICE });
        dc = pc.createDataChannel('api');

        dc.onopen = () => {
          dcReady = true;
          mode = 'webrtc';
          // Close signaling socket once WebRTC is established to save resources.
          try { ws && ws.close(); } catch {}
          ws = null;
          finish(true);
        };
        dc.onclose = () => { dcReady = false; };
        dc.onmessage = (e) => {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          const p = pending.get(m.id);
          if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
        };

        pc.onicecandidate = (e) => {
          if (e.candidate && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'CANDIDATE',
              dst: serverPeerId,
              src: clientId,
              token: token,
              payload: { candidate: e.candidate.candidate, type: 'candidate', sdpMid: e.candidate.sdpMid }
            }));
          }
        };

        ws.onmessage = async (e) => {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          if (m.type === 'OPEN') {
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              ws.send(JSON.stringify({
                type: 'OFFER',
                dst: serverPeerId,
                src: clientId,
                token: token,
                payload: { sdp: pc.localDescription.sdp, type: 'offer' }
              }));
            } catch { finish(false); }
          } else if (m.type === 'ANSWER' && m.payload?.sdp) {
            try {
              const sdpData = typeof m.payload.sdp === 'string' ? m.payload.sdp : m.payload.sdp.sdp;
              await pc.setRemoteDescription({ type: m.payload.type || 'answer', sdp: sdpData });
            } catch {}
          } else if (m.type === 'CANDIDATE' && m.payload?.candidate) {
            try {
              const candStr = typeof m.payload.candidate === 'string' ? m.payload.candidate : m.payload.candidate.candidate;
              await pc.addIceCandidate({ candidate: candStr, sdpMid: m.payload.sdpMid || '0' });
            } catch {}
          }
        };
        ws.onerror = () => { if (!dcReady) finish(false); };
        ws.onclose = () => { if (!dcReady) finish(false); };

        setTimeout(() => finish(dcReady), timeoutMs);
      } catch { finish(false); }
    });
  }

  function teardown() {
    dcReady = false;
    try { dc && dc.close(); } catch {}
    try { pc && pc.close(); } catch {}
    try { ws && ws.close(); } catch {}
    dc = pc = ws = null;
  }

  function normalize(status, data) {
    if (status === 403 && data && data.error === 'revoked') { const e = new Error('revoked'); e.revoked = true; throw e; }
    if (status >= 400) { const e = new Error((data && data.error) || ('Error ' + status)); e.status = status; throw e; }
    return data;
  }

  function viaWebRTC(method, path, body) {
    return new Promise((resolve, reject) => {
      const id = ATT.genId();
      const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 12000);
      pending.set(id, { resolve, reject, timer });
      try { dc.send(JSON.stringify({ id, method, path, body, token: deviceToken })); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    }).then((reply) => normalize(reply.status, reply.body));
  }

  async function viaRest(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
      res = await fetch(serverUrl + path, {
        method, signal: ctrl.signal,
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'Bypass-Tunnel-Reminder': 'true' },
          deviceToken ? { 'x-device-token': deviceToken } : {}
        ),
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e.name === 'AbortError' ? 'The server did not respond. Check your internet and try again.' : 'Cannot reach the server. It may be off or offline.');
    }
    clearTimeout(timer);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('Remote access is not ready yet (got a warning page). Ask the admin to open the school app on the office PC, then try again.'); }
    return normalize(res.status, data);
  }

  // Main entry. path includes the /api prefix, e.g. request('/api/me').
  async function request(path, opts) {
    opts = opts || {};
    const method = opts.method || 'GET';
    const body = opts.body;
    if (dcReady) {
      try { return await viaWebRTC(method, path, body); }
      catch (e) { if (e.revoked) throw e; /* fall through to REST */ }
    }
    return viaRest(method, path, body);
  }

  ATT.conn = { setEndpoint, connectWebRTC, request, teardown, getMode };
})();
