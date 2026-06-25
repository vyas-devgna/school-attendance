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
  function connectWebRTC(timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    teardown();
    if (!('RTCPeerConnection' in window) || !serverUrl) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        ws = new WebSocket(wsUrl());
        pc = new RTCPeerConnection({ iceServers: ATT.ICE });
        dc = pc.createDataChannel('api');

        dc.onopen = () => { dcReady = true; mode = 'webrtc'; finish(true); };
        dc.onclose = () => { dcReady = false; };
        dc.onmessage = (e) => {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          const p = pending.get(m.id);
          if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
        };

        pc.onicecandidate = (e) => {
          if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate.toJSON() }));
        };

        ws.onopen = async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
          } catch { finish(false); }
        };
        ws.onmessage = async (e) => {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          try {
            if (m.type === 'answer') await pc.setRemoteDescription(m.sdp);
            else if (m.type === 'ice' && m.candidate) await pc.addIceCandidate(m.candidate);
          } catch {}
        };
        ws.onerror = () => finish(dcReady);
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
