// ponytail: shared client config + tiny helpers used by BOTH admin and teacher apps.
// Loaded as a plain <script> — attaches to window.ATT. No build step.
(function () {
  const ATT = (window.ATT = window.ATT || {});

  ATT.VERSION = '2.1.0';

  // Default public endpoint for remote (off-LAN) use. This is the STABLE localtunnel
  // subdomain the server requests on startup, so saved pairings survive restarts.
  // If you switch tunnels, change this one line (and re-deploy /docs).
  ATT.PUBLIC_SERVER = 'https://vyas-devgna-att.loca.lt';

  ATT.ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

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
})();
