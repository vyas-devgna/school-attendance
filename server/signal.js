// ponytail: public signalling for first pairing and reconnect; API data stays inside WebRTC.
const { WebSocket } = require('ws');
const rtc = require('node-datachannel');

// Keep track of active WebRTC peer connections
const activePeers = new Map(); // clientSrc -> { pc, ws }

function attachSignal(httpServer, { dispatch, iceServers, fingerprint }) {
  if (!fingerprint) {
    // RUN THE OLD LOCAL WEBSOCKET SERVER FOR OFFLINE TESTS / FALLBACK!
    const { WebSocketServer } = require('ws');
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
    wss.isConnected = () => true;
    return wss;
  }

  // CONNECT TO THE PUBLIC PEERJS SIGNALING SERVER!
  console.log(`[Signaling] Initializing PeerJS WebRTC bridge with fingerprint: ${fingerprint}`);
  const pairingConn = connectSignaling('vyas-school-att', { dispatch, iceServers });
  const mainConn = connectSignaling('vyas-school-att-' + fingerprint, { dispatch, iceServers });

  return {
    isConnected: () => pairingConn.isOpen() && mainConn.isOpen(),
    close: (callback) => {
      pairingConn.close();
      mainConn.close();
      for (const peer of activePeers.values()) {
        try { peer.pc.close(); } catch {}
      }
      activePeers.clear();
      if (callback) callback();
    }
  };
}

function connectSignaling(peerId, { dispatch, iceServers }) {
  const token = Math.random().toString(36).slice(2, 10);
  const url = `wss://0.peerjs.com/peerjs?key=peerjs&id=${peerId}&token=${token}&version=1.4.7`;
  let ws = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let isClosed = false;

  const connect = () => {
    if (isClosed) return;
    console.log(`[Signaling] Connecting to PeerJS server for ID: ${peerId}`);
    ws = new WebSocket(url);
    ws.token = token;

    ws.on('open', () => {
      console.log(`[Signaling] WebSocket open for ID: ${peerId}`);
      // Send heartbeats every 15 seconds to keep the connection alive
      heartbeatTimer = setInterval(() => {
        safeSend(ws, { type: 'HEARTBEAT' });
      }, 15000);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'OPEN') {
        console.log(`[Signaling] Successfully registered on PeerJS server with ID: ${peerId}`);
      } else if (msg.type === 'OFFER' && msg.payload?.sdp) {
        const clientSrc = msg.src;
        console.log(`[Signaling] Received OFFER from client: ${clientSrc}`);

        // Clean up any existing stale connection for this client
        const existing = activePeers.get(clientSrc);
        if (existing) {
          try { existing.pc.close(); } catch {}
          activePeers.delete(clientSrc);
        }

        try {
          const pc = new rtc.PeerConnection('attendance-server', {
            iceServers: (iceServers || []).map(toIceServer),
          });
          activePeers.set(clientSrc, { pc, ws });

          pc.onStateChange(state => {
            console.log(`[WebRTC] Connection to ${clientSrc} state: ${state}`);
            if (state === 'disconnected' || state === 'failed' || state === 'closed') {
              if (activePeers.get(clientSrc)?.pc === pc) {
                activePeers.delete(clientSrc);
              }
              try { pc.close(); } catch {}
            }
          });

          pc.onLocalDescription((sdp, type) => {
            console.log(`[Signaling] Sending ANSWER to client: ${clientSrc}`);
            safeSend(ws, {
              type: 'ANSWER',
              dst: clientSrc,
              src: peerId,
              payload: { sdp, type },
              token: token
            });
          });

          pc.onLocalCandidate((candidate, mid) => {
            safeSend(ws, {
              type: 'CANDIDATE',
              dst: clientSrc,
              src: peerId,
              payload: { candidate, type: 'candidate', sdpMid: mid },
              token: token
            });
          });

          pc.onDataChannel(channel => {
            console.log(`[WebRTC] DataChannel opened by client: ${clientSrc}`);
            wireChannel(channel, dispatch);
          });

          pc.setRemoteDescription(msg.payload.sdp, msg.payload.type || 'offer');
        } catch (err) {
          console.error(`[WebRTC] Error setting up PeerConnection:`, err.message);
          safeSend(ws, {
            type: 'ERROR',
            dst: clientSrc,
            src: peerId,
            payload: { msg: err.message },
            token: token
          });
        }
      } else if (msg.type === 'CANDIDATE' && msg.payload?.candidate) {
        const clientSrc = msg.src;
        const peer = activePeers.get(clientSrc);
        if (peer) {
          try {
            peer.pc.addRemoteCandidate(msg.payload.candidate, msg.payload.sdpMid || '0');
          } catch (err) {
            console.error(`[WebRTC] Error adding remote candidate:`, err.message);
          }
        }
      }
    });

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      ws = null;
      if (!isClosed) {
        // Try to reconnect in 5 seconds
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 5000);
      }
    };

    ws.on('close', (code, reason) => {
      console.log(`[Signaling] WebSocket closed for ID ${peerId} (code: ${code}, reason: ${reason}). Reconnecting...`);
      cleanup();
    });

    ws.on('error', (err) => {
      console.error(`[Signaling] WebSocket error for ID ${peerId}:`, err.message);
      cleanup();
    });
  };

  connect();

  return {
    isOpen: () => ws && ws.readyState === 1,
    close: () => {
      isClosed = true;
      clearInterval(heartbeatTimer);
      clearTimeout(reconnectTimer);
      try { ws && ws.close(); } catch {}
    }
  };
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
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {}
}

function cleanupRtc() {
  try { rtc.cleanup(); } catch {}
}

module.exports = { attachSignal, cleanupRtc };
