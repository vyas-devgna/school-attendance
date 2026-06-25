// ponytail: ONE pairing implementation for admin + teacher. QR and 6-digit code both call
// enroll() with the same shape, so they can never drift. Attaches window.ATT.pairing.
(function () {
  const ATT = (window.ATT = window.ATT || {});
  const KEY = 'att_pairing';

  function get() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
  function save(p) { localStorage.setItem(KEY, JSON.stringify(p)); }
  function clear() { localStorage.removeItem(KEY); ATT.conn.teardown(); }

  // Parse a scanned QR. v2 = JSON {server, token, code, role, appType}. Tolerates older payloads.
  function parseQR(raw) {
    try {
      const d = JSON.parse(raw);
      if (d && d.token) return { server: d.server || ATT.PUBLIC_SERVER, token: d.token, role: d.role, appType: d.appType };
    } catch {}
    return null;
  }

  // Enroll this device. expectApp = 'admin' | 'teacher' (the app doing the pairing).
  // Returns the stored pairing object, or throws an Error with a friendly message.
  async function enroll({ server, token, code, expectApp }) {
    const base = ATT.isLocalServed() ? location.origin : '';
    const deviceId = (get() && get().deviceId) || ATT.genId();
    ATT.conn.setEndpoint(base, null);

    // Remote devices reach the office PC over WebRTC (P2P via the free broker).
    if (!ATT.isLocalServed()) {
      const up = await ATT.conn.connectWebRTC().catch(() => false);
      if (!up) throw new Error('Could not reach the school server. Make sure the office computer is on and connected to the internet, then try again.');
    }

    const body = { deviceId, appType: expectApp };
    if (token) body.token = token; else body.code = code;
    const res = await ATT.conn.request('/api/enroll', { method: 'POST', body });

    const pairing = {
      deviceId,
      deviceToken: res.deviceToken,
      server: base,
      role: res.user.role,
      user: res.user,
      serverId: res.server && res.server.serverId,
      fingerprint: res.server && res.server.fingerprint,
      endpoints: res.server && res.server.endpoints,
      pairedAt: new Date().toISOString(),
    };
    save(pairing);
    ATT.conn.setEndpoint(base, res.deviceToken); // authenticate subsequent calls
    return pairing;
  }

  // Re-establish transport for an already-paired device (on app open / reconnect).
  async function reconnect() {
    const p = get();
    if (!p) return null;
    const base = ATT.isLocalServed() ? location.origin : '';

    // Verify identity with no token first, then attach the token only to the real server.
    ATT.conn.setEndpoint(base, null);
    if (!ATT.isLocalServed()) await ATT.conn.connectWebRTC().catch(() => {});

    let info;
    try { info = await ATT.conn.request('/api/server-info'); }
    catch (e) { return p; } // server unreachable right now — stay offline, keep queue

    if (p.fingerprint && info.fingerprint !== p.fingerprint) {
      throw new Error('This is not the paired school server. Ask the admin to pair this device again.');
    }
    ATT.conn.setEndpoint(base, p.deviceToken); // authenticate subsequent calls
    return p;
  }

  ATT.pairing = { get, save, clear, parseQR, enroll, reconnect };
})();
