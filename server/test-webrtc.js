// ponytail: signalling + DataChannel request self-check. Real Chromium interop is smoke-tested separately.
const http = require('http');
const { WebSocket } = require('ws');
const rtc = require('node-datachannel');
const { attachSignal, cleanupRtc } = require('./signal');

const PORT = 3999;
const server = http.createServer();
const signalling = attachSignal(server, {
  iceServers: [],
  dispatch: async (method, path, body, ctx) => ({ status: 200, body: { method, path, token: ctx.token } }),
});

function finish(code, message) {
  console[code ? 'error' : 'log'](message);
  signalling.close(() => server.close(() => {
    cleanupRtc();
    process.exit(code);
  }));
}

server.listen(PORT, '127.0.0.1', () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/signal`);
  const pc = new rtc.PeerConnection('test-client', { iceServers: [] });
  const timer = setTimeout(() => finish(1, 'FAIL: timed out'), 8000);

  pc.onLocalDescription((sdp, type) => ws.send(JSON.stringify({ type: 'offer', sdp: { sdp, type } })));
  pc.onLocalCandidate((candidate, mid) => ws.send(JSON.stringify({ type: 'ice', candidate: { candidate, sdpMid: mid } })));

  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'answer') pc.setRemoteDescription(msg.sdp.sdp, msg.sdp.type);
    else if (msg.type === 'ice') pc.addRemoteCandidate(msg.candidate.candidate, msg.candidate.sdpMid || '0');
  });

  ws.on('open', () => {
    const dc = pc.createDataChannel('api');
    dc.onOpen(() => dc.sendMessage(JSON.stringify({ id: 'r1', method: 'GET', path: '/api/me', token: 'secret-123' })));
    dc.onMessage(data => {
      const reply = JSON.parse(typeof data === 'string' ? data : data.toString());
      clearTimeout(timer);
      const ok = reply.id === 'r1' && reply.status === 200 && reply.body?.path === '/api/me' && reply.body?.token === 'secret-123';
      try { dc.close(); pc.close(); ws.close(); } catch {}
      finish(ok ? 0 : 1, ok ? 'PASS: WebRTC DataChannel request reached dispatch' : `FAIL: ${JSON.stringify(reply)}`);
    });
  });
});
