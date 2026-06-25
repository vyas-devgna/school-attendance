// ponytail: pure-P2P signalling using the REAL PeerJS library on both ends (hand-rolling the
// PeerJS wire protocol was the bug — the broker silently dropped malformed messages). The office
// PC registers ONE stable peer id on the free PeerJS broker (0.peerjs.com). Browsers connect to
// it over WebRTC; STUN/TURN handle NAT. Once a DataConnection opens, framed API requests are
// bridged to the local Express routes (loopback HTTP). No tunnel, no public HTTP server.
const ndc = require('node-datachannel');

// PeerJS needs browser globals; node-datachannel provides a WebRTC polyfill for Node.
const wrtc = require('node-datachannel/polyfill');
global.RTCPeerConnection = global.RTCPeerConnection || wrtc.RTCPeerConnection;
global.RTCSessionDescription = global.RTCSessionDescription || wrtc.RTCSessionDescription;
global.RTCIceCandidate = global.RTCIceCandidate || wrtc.RTCIceCandidate;
global.WebSocket = global.WebSocket || require('ws');
const { Peer } = require('peerjs');

function attachSignal(httpServer, { dispatch, iceServers, peerId }) {
  if (!peerId) return attachLocalSignal(httpServer, { dispatch, iceServers }); // offline/test mode

  let peer = null, open = false, closed = false, retry = null;
  const conns = new Set();

  function start() {
    if (closed) return;
    peer = new Peer(peerId, { debug: 0, config: { iceServers } });

    peer.on('open', (id) => { open = true; console.log(`[signal] online on the free broker as "${id}"`); });

    peer.on('connection', (conn) => {
      conns.add(conn);
      conn.on('data', async (req) => {
        if (!req || !req.id || !String(req.path || '').startsWith('/api/')) return;
        try {
          const { status, body } = await dispatch(req.method || 'GET', req.path, req.body, { token: req.token });
          try { conn.send({ id: req.id, status, body }); } catch {}
        } catch {
          try { conn.send({ id: req.id, status: 500, body: { error: 'Request failed' } }); } catch {}
        }
      });
      conn.on('close', () => conns.delete(conn));
      conn.on('error', () => conns.delete(conn));
    });

    // Keep the rendezvous alive forever.
    peer.on('disconnected', () => { open = false; if (!closed) { try { peer.reconnect(); } catch { scheduleRestart(); } } });
    peer.on('error', (e) => {
      open = false;
      console.error('[signal] broker error:', e.type);
      if (['unavailable-id', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) scheduleRestart();
    });
  }

  function scheduleRestart() {
    if (closed) return;
    clearTimeout(retry);
    retry = setTimeout(() => { try { peer && peer.destroy(); } catch {} start(); }, 5000);
  }

  start();

  return {
    isConnected: () => open,
    close: (cb) => { closed = true; clearTimeout(retry); try { peer && peer.destroy(); } catch {} if (cb) cb(); },
  };
}

// Local WebSocket signalling (same machine) — offline tests only. Browsers use PeerJS, not this.
function attachLocalSignal(httpServer, { dispatch, iceServers }) {
  const { WebSocketServer } = require('ws');
  const ice = (iceServers || []).map(toIceServer);
  const wss = new WebSocketServer({ server: httpServer, path: '/signal', maxPayload: 256 * 1024 });
  wss.on('connection', (ws) => {
    let pc = null;
    const close = () => { if (pc) { try { pc.close(); } catch {} pc = null; } };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (m.type === 'offer' && !pc && m.sdp && m.sdp.sdp) {
          pc = new ndc.PeerConnection('att-server', { iceServers: ice });
          pc.onLocalDescription((sdp, type) => safeSend(ws, { type: 'answer', sdp: { sdp, type } }));
          pc.onLocalCandidate((candidate, mid) => safeSend(ws, { type: 'ice', candidate: { candidate, sdpMid: mid } }));
          pc.onDataChannel((channel) => wireChannel(channel, dispatch));
          pc.setRemoteDescription(m.sdp.sdp, m.sdp.type || 'offer');
        } else if (m.type === 'ice' && pc && m.candidate && m.candidate.candidate) {
          pc.addRemoteCandidate(m.candidate.candidate, m.candidate.sdpMid || '0');
        }
      } catch {}
    });
    ws.on('close', close);
    ws.on('error', close);
  });
  return { isConnected: () => true, close: (cb) => { try { wss.close(); } catch {} if (cb) cb(); } };
}

// node-datachannel raw DataChannel (local test path only).
function wireChannel(channel, dispatch) {
  const reply = (obj) => { try { channel.sendMessage(JSON.stringify(obj)); } catch {} };
  channel.onMessage(async (data) => {
    let req; try { req = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
    if (!req || !req.id || !String(req.path || '').startsWith('/api/')) return;
    try {
      const { status, body } = await dispatch(req.method || 'GET', req.path, req.body, { token: req.token });
      reply({ id: req.id, status, body });
    } catch {
      reply({ id: req.id, status: 500, body: { error: 'Request failed' } });
    }
  });
}

function toIceServer(s) {
  const url = Array.isArray(s.urls) ? s.urls[0] : s.urls;
  if (!s.username) return url;
  return String(url).replace(/^(turns?):/, `$1:${s.username}:${s.credential || ''}@`);
}
function safeSend(ws, obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }
function cleanupRtc() { try { ndc.cleanup(); } catch {} }

module.exports = { attachSignal, cleanupRtc };
