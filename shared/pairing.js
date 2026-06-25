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
    const base = (server || ATT.PUBLIC_SERVER).replace(/\/+$/, '');
    const deviceId = (get() && get().deviceId) || ATT.genId();
    ATT.conn.setEndpoint(base, null);

    // Try the WebRTC pipeline first (the requested transport); silently fall back to REST.
    await ATT.conn.connectWebRTC().catch(() => {});

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
    // Served by the local server (localhost/LAN) → same-origin REST, no tunnel/WebRTC needed.
    const base = ATT.isLocalServed() ? location.origin : p.server;
    ATT.conn.setEndpoint(base, p.deviceToken);
    if (!ATT.isLocalServed()) await ATT.conn.connectWebRTC().catch(() => {});
    return p;
  }

  ATT.pairing = { get, save, clear, parseQR, enroll, reconnect };
})();
