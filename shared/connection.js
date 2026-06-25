// ponytail: ONE transport. On the office PC (served locally) → same-origin REST. Everywhere
// else → a WebRTC DataConnection to the office PC using the real PeerJS library (correct wire
// protocol + STUN/TURN). No tunnel, no public HTTP server. If the channel isn't up, request()
// throws a clear error and the caller keeps data in the offline queue. Attaches window.ATT.conn.
(function () {
  const ATT = (window.ATT = window.ATT || {});

  let serverUrl = null;      // same-origin base, only used when served by the PC
  let deviceToken = null;
  let peer = null, conn = null, ready = false, connecting = null;
  const pending = new Map(); // requestId -> { resolve, reject, timer }

  function setEndpoint(url, token) {
    serverUrl = (url || '').replace(/\/+$/, '');
    deviceToken = token || null;
  }
  function getMode() { return ready ? 'webrtc' : (ATT.isLocalServed() ? 'local' : 'offline'); }

  function teardown() {
    ready = false;
    try { conn && conn.close(); } catch {}
    try { peer && peer.destroy(); } catch {}
    conn = peer = null;
  }

  // Open a WebRTC DataConnection to the office PC via the free PeerJS broker. Resolves true on success.
  function connectWebRTC(timeoutMs) {
    if (ready && conn && conn.open) return Promise.resolve(true);
    if (connecting) return connecting;
    timeoutMs = timeoutMs || 20000; // TURN handshakes can be slow on first connect
    if (typeof window.Peer !== 'function') return Promise.resolve(false);

    connecting = new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; connecting = null; resolve(v); } };
      teardown();
      try {
        peer = new Peer({ debug: 0, config: { iceServers: ATT.ICE } });
        const t = setTimeout(() => finish(false), timeoutMs);
        peer.on('open', () => {
          conn = peer.connect(ATT.SERVER_PEER_ID, { reliable: true });
          conn.on('open', () => { ready = true; clearTimeout(t); finish(true); });
          conn.on('data', (m) => {
            const p = m && pending.get(m.id);
            if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
          });
          conn.on('close', () => { ready = false; });
          conn.on('error', () => { if (!ready) { clearTimeout(t); finish(false); } });
        });
        peer.on('error', () => { if (!ready) { clearTimeout(t); finish(false); } });
        peer.on('disconnected', () => { ready = false; });
      } catch { finish(false); }
    });
    return connecting;
  }

  function normalize(status, data) {
    if (status === 403 && data && data.error === 'revoked') { const e = new Error('revoked'); e.revoked = true; throw e; }
    if (status >= 400) { const e = new Error((data && data.error) || ('Error ' + status)); e.status = status; throw e; }
    return data;
  }

  function viaWebRTC(method, path, body) {
    return new Promise((resolve, reject) => {
      const id = ATT.genId();
      const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('The school server did not answer. Try again.')); } }, 15000);
      pending.set(id, { resolve, reject, timer });
      try { conn.send({ id, method, path, body, token: deviceToken }); }
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
        headers: Object.assign({ 'Content-Type': 'application/json' }, deviceToken ? { 'x-device-token': deviceToken } : {}),
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e.name === 'AbortError' ? 'The server did not respond. Try again.' : 'Cannot reach the school server.');
    }
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    return normalize(res.status, data);
  }

  // path includes /api, e.g. request('/api/me'). On the PC → REST. Remote → WebRTC only.
  async function request(path, opts) {
    opts = opts || {};
    const method = opts.method || 'GET';
    const body = opts.body;
    if (ATT.isLocalServed()) return viaRest(method, path, body);

    if (!ready) {
      await connectWebRTC().catch(() => {});
      if (!ready) { const e = new Error('Not connected to the school server. Make sure the office computer is on, then try again.'); e.offline = true; throw e; }
    }
    try { return await viaWebRTC(method, path, body); }
    catch (e) {
      if (e.revoked) throw e;
      ready = false;                       // one reconnect + retry before giving up
      await connectWebRTC().catch(() => {});
      if (!ready) { e.offline = true; throw e; }
      return viaWebRTC(method, path, body);
    }
  }

  ATT.conn = { setEndpoint, connectWebRTC, request, teardown, getMode };
})();
