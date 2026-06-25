// ponytail: self-test — proves /signal establishes a WebRTC DataChannel and
// dispatches a framed request to the (stubbed) loopback handler. werift plays
// the "browser" peer. Run: node test-webrtc.js
const http = require('http');
const { WebSocket } = require('ws');
const { RTCPeerConnection } = require('werift');
const { attachSignal } = require('./signal');

const PORT = 3999;

function main() {
  const server = http.createServer();
  // stub dispatch: echoes path + token so we can assert the bridge works
  attachSignal(server, {
    iceServers: [],
    dispatch: async (method, path, body, ctx) =>
      ({ status: 200, body: { echo: { method, path, token: ctx.token } } }),
  });

  server.listen(PORT, '127.0.0.1', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/signal`);
    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel('api');

    const timer = setTimeout(() => fail('timed out — no reply over DataChannel'), 8000);

    pc.onIceCandidate.subscribe((c) => {
      const cand = (c && c.candidate) ? c.candidate : c;
      if (cand) ws.send(JSON.stringify({ type: 'ice', candidate: cand.toJSON ? cand.toJSON() : cand }));
    });

    ws.on('open', async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
    });

    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'answer') await pc.setRemoteDescription(msg.sdp);
      else if (msg.type === 'ice') await pc.addIceCandidate(msg.candidate);
    });

    dc.stateChanged.subscribe((state) => {
      if (state === 'open') dc.send(JSON.stringify({ id: 'r1', method: 'GET', path: '/api/me', token: 'secret-123' }));
    });

    dc.onMessage.subscribe((data) => {
      const reply = JSON.parse(typeof data === 'string' ? data : data.toString());
      clearTimeout(timer);
      const e = reply.body && reply.body.echo;
      if (reply.id === 'r1' && reply.status === 200 && e && e.path === '/api/me' && e.token === 'secret-123') {
        console.log('PASS: WebRTC DataChannel request reached dispatch and replied:', JSON.stringify(reply.body));
        pc.close(); ws.close(); server.close(); process.exit(0);
      } else {
        fail('unexpected reply: ' + JSON.stringify(reply));
      }
    });
  });
}

function fail(m) { console.error('FAIL:', m); process.exit(1); }
main();
