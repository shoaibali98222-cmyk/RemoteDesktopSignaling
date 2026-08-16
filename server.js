const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({
  port: PORT
});

const sessions = new Map();

console.log(`Signaling server running on ws://localhost:${PORT}`);

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function generateSessionCode() {
  let code;

  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (sessions.has(code));

  return code;
}

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.sessionCode = null;
  ws.role = null;

  ws.on('message', (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      send(ws, {
        type: 'error',
        message: 'Invalid JSON message.'
      });
      return;
    }

    // ============================
    // CREATE SESSION
    // ============================

    if (message.action === 'create-session') {
      const code = generateSessionCode();

      sessions.set(code, {
        host: ws,
        controller: null
      });

      ws.sessionCode = code;
      ws.role = 'host';

      send(ws, {
        type: 'session-created',
        code: code
      });

      console.log(`Session created: ${code}`);
      return;
    }

    // ============================
    // JOIN SESSION
    // ============================

    if (message.action === 'join-session') {
      const code = String(message.code || '');
      const session = sessions.get(code);

      if (!session) {
        send(ws, {
          type: 'error',
          message: 'Session not found.'
        });
        return;
      }

      if (session.controller) {
        send(ws, {
          type: 'error',
          message: 'Session already has a controller.'
        });
        return;
      }

      session.controller = ws;

      ws.sessionCode = code;
      ws.role = 'controller';

      send(ws, {
        type: 'session-joined',
        code: code
      });

      send(session.host, {
        type: 'controller-joined',
        code: code
      });

      console.log(`Controller joined session: ${code}`);
      return;
    }

    // ============================
    // WEBRTC SIGNALING
    // ============================

    if (message.action === 'signal') {
      const code = String(message.code || '');
      const session = sessions.get(code);

      if (!session) {
        send(ws, {
          type: 'error',
          message: 'Session not found.'
        });
        return;
      }

      let target = null;

      if (ws.role === 'host') {
        target = session.controller;
      } else if (ws.role === 'controller') {
        target = session.host;
      }

      if (!target) {
        send(ws, {
          type: 'error',
          message: 'Peer is not connected.'
        });
        return;
      }

      send(target, {
        type: 'signal',
        data: message.payload
      });

      return;
    }

    // ============================
    // UNKNOWN ACTION
    // ============================

    send(ws, {
      type: 'error',
      message: `Unknown action: ${message.action}`
    });
  });

  // ============================
  // DISCONNECT
  // ============================

  ws.on('close', () => {
    console.log('Client disconnected');

    const code = ws.sessionCode;

    if (!code) {
      return;
    }

    const session = sessions.get(code);

    if (!session) {
      return;
    }

    if (ws.role === 'host') {
      if (session.controller) {
        send(session.controller, {
          type: 'error',
          message: 'Host disconnected.'
        });
      }

      sessions.delete(code);
      console.log(`Session deleted: ${code}`);
    }

    if (ws.role === 'controller') {
      session.controller = null;

      if (session.host) {
        send(session.host, {
          type: 'error',
          message: 'Controller disconnected.'
        });
      }

      console.log(`Controller left session: ${code}`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});