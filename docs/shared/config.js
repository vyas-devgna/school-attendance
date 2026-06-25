// ponytail: shared client config + tiny helpers used by BOTH admin and teacher apps.
// Loaded as a plain <script> — attaches to window.ATT. No build step.
(function () {
  const ATT = (window.ATT = window.ATT || {});

  ATT.VERSION = '3.0.0';

  // Pure P2P: no tunnel, no public HTTP server. Remote devices reach the office PC over a
  // WebRTC DataChannel. The office PC registers ONE stable peer id on the free PeerJS broker
  // (0.peerjs.com) and every device connects to it. MUST match PEER_ID in server/index.js.
  ATT.SERVER_PEER_ID = 'att-vyasdevgna-school-9k4f2';

  // Free public STUN (for normal NATs) + free TURN relay (for hard/symmetric NATs and
  // cellular). TURN is what makes pairing work when both sides are behind routers. These are
  // public shared credentials (not secret).
  ATT.ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  // Stable id with a fallback for plain-HTTP origins where crypto.randomUUID is absent.
  ATT.genId = function () {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxx-xxxx-xxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16)) + '-' + Date.now().toString(36);
  };
  ATT.esc = function (value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  };
  ATT.localDate = function (date) {
    const d = date || new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };

  // Is this page being served BY the local server (localhost / LAN :3000)? Then we talk
  // same-origin REST and never need the tunnel or WebRTC.
  ATT.isLocalServed = function () {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || location.port === '3000';
  };
  ATT.isOfficePc = function () {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  };

  // Never let a failed icon CDN crash the app (RC-6). Real icons come from the vendored file.
  window.lucide = window.lucide || { createIcons: function () {} };

  // When a new service worker takes over (a deploy shipped new code), reload ONCE so the
  // user never runs stale JS (RC-5). Skips the first-ever install (no prior controller).
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
  }
  // Helper to compute SHA-256 hash of a string in secure contexts (HTTPS / localhost).
  ATT.sha256 = async function (str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  };
})();
