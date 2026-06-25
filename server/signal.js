// ponytail: WebRTC signalling + data-pipeline bridge.
// A browser opens a WebSocket to /signal, sends an SDP offer + ICE candidates.
// We answer with a werift RTCPeerConnection. When the DataChannel opens, each
// framed request {id, method, path, body, token} is dispatched to the EXISTING
// Express routes via an internal loopback HTTP call (zero handler duplication),
// and the reply {id, status, body} is sent back over the channel.
const { WebSocketServer } = require('ws');
const { RTCPeerConnection } = require('werift');

function attachSignal(httpServer, { dispatch, iceServers }) {
  const wss = new WebSocketServer({ server: httpServer, path: '/signal' });

  wss.on('connection', (ws) => {
    let pc = null;
    const closePc = () => { try { if (pc) pc.close(); } catch {} pc = null; };

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (msg.type === 'offer') {
          pc = new RTCPeerConnection({ iceServers: iceServers || [] });

          pc.onIceCandidate.subscribe((c) => {
            const cand = (c && c.candidate) ? c.candidate : c;
            if (!cand) return;
            const json = cand.toJSON ? cand.toJSON() : cand;
            safeSend(ws, { type: 'ice', candidate: json });
          });

          pc.onDataChannel.subscribe((channel) => wireChannel(channel, dispatch));

          await pc.setRemoteDescription(msg.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          safeSend(ws, { type: 'answer', sdp: pc.localDescription });
        } else if (msg.type === 'ice' && pc && msg.candidate) {
          await pc.addIceCandidate(msg.candidate);
        }
      } catch (e) {
        safeSend(ws, { type: 'error', error: String(e && e.message || e) });
      }
    });

    ws.on('close', closePc);
    ws.on('error', closePc);
  });

  return wss;
}

function wireChannel(channel, dispatch) {
  const reply = (obj) => { try { channel.send(JSON.stringify(obj)); } catch {} };
  channel.onMessage.subscribe(async (data) => {
    let req;
    try { req = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
    if (!req || !req.id) return;
    try {
      const { status, body } = await dispatch(req.method || 'GET', req.path, req.body, { token: req.token });
      reply({ id: req.id, status, body });
    } catch (e) {
      reply({ id: req.id, status: 500, body: { error: String(e && e.message || e) } });
    }
  });
}

function safeSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

module.exports = { attachSignal };
