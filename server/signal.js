// ponytail: public signalling for first pairing and reconnect; API data stays inside WebRTC.
const { WebSocketServer } = require('ws');
const rtc = require('node-datachannel');

function attachSignal(httpServer, { dispatch, iceServers }) {
  const peers = new Set();
  const wss = new WebSocketServer({ server: httpServer, path: '/signal', maxPayload: 256 * 1024 });

  wss.on('connection', (ws) => {
    if (peers.size >= 50) return ws.close(1013, 'Busy');
    let pc = null;
    const timer = setTimeout(() => ws.close(1000, 'Timed out'), 30000);
    const closePeer = () => {
      clearTimeout(timer);
      if (!pc) return;
      peers.delete(pc);
      try { pc.close(); } catch {}
      pc = null;
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (msg.type === 'offer' && !pc && msg.sdp?.sdp) {
          pc = new rtc.PeerConnection('attendance-server', {
            iceServers: (iceServers || []).map(toIceServer),
          });
          peers.add(pc);
          pc.onLocalDescription((sdp, type) => safeSend(ws, { type: 'answer', sdp: { sdp, type } }));
          pc.onLocalCandidate((candidate, mid) => safeSend(ws, { type: 'ice', candidate: { candidate, sdpMid: mid } }));
          pc.onDataChannel(channel => {
            clearTimeout(timer);
            wireChannel(channel, dispatch);
          });
          pc.setRemoteDescription(msg.sdp.sdp, msg.sdp.type || 'offer');
        } else if (msg.type === 'ice' && pc && msg.candidate?.candidate) {
          pc.addRemoteCandidate(msg.candidate.candidate, msg.candidate.sdpMid || '0');
        }
      } catch (e) {
        safeSend(ws, { type: 'error', error: String(e?.message || e) });
      }
    });

    ws.on('close', closePeer);
    ws.on('error', closePeer);
  });

  wss.on('close', () => {
    for (const pc of peers) try { pc.close(); } catch {}
    peers.clear();
  });
  return wss;
}

function toIceServer(server) {
  const url = Array.isArray(server.urls) ? server.urls[0] : server.urls;
  if (!server.username) return url;
  return String(url).replace(/^(turns?):/, `$1:${server.username}:${server.credential || ''}@`);
}

function wireChannel(channel, dispatch) {
  const reply = obj => { try { channel.sendMessage(JSON.stringify(obj)); } catch {} };
  channel.onMessage(async data => {
    let req;
    try { req = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
    if (!req?.id || !String(req.path || '').startsWith('/api/')) return;
    try {
      const { status, body } = await dispatch(req.method || 'GET', req.path, req.body, { token: req.token });
      reply({ id: req.id, status, body });
    } catch {
      reply({ id: req.id, status: 500, body: { error: 'Request failed' } });
    }
  });
}

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function cleanupRtc() {
  try { rtc.cleanup(); } catch {}
}

module.exports = { attachSignal, cleanupRtc };
