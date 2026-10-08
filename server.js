const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// Optional: comma-separated list of allowed page origins, e.g.
// ALLOWED_ORIGINS=https://myapp.example.com
// If empty, any origin is accepted.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_PAYLOAD = 64 * 1024;               // bytes per message
const MAX_SESSIONS = 200;
const MAX_CONNECTIONS_PER_IP = 10;
const WAITING_SESSION_TTL_MS = 10 * 60 * 1000; // unjoined session expires after 10 min
const APPROVAL_TIMEOUT_MS = 30 * 1000;         // host has 30 s to approve
const MAX_FAILED_JOINS = 5;                    // per IP per window
const FAIL_WINDOW_MS = 60 * 1000;
const BLOCK_MS = 5 * 60 * 1000;
const MSG_LIMIT = 300;                         // messages per 10 s per connection
const MSG_WINDOW_MS = 10 * 1000;
const HEARTBEAT_MS = 30 * 1000;

const SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate']);

// ---- TURN credentials (kept on the server, never in the web page) ----
// Preferred: short-lived credentials from the Metered API
const METERED_APP = process.env.METERED_APP || '';               // e.g. "myapp" (from myapp.metered.live)
const METERED_SECRET_KEY = process.env.METERED_SECRET_KEY || '';
const TURN_TTL_SECONDS = 4 * 60 * 60;                            // credential lives 4 hours
// Fallback: a fixed credential stored only in Render env vars
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';

const STUN_ONLY = [{ urls: 'stun:stun.relay.metered.ca:80' }];

function buildIceServers(username, credential) {
  return [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username, credential },
    { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username, credential },
    { urls: 'turn:global.relay.metered.ca:443', username, credential },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username, credential }
  ];
}

// Never throws. Falls back step by step so connections keep working.
async function getIceServers() {
  if (METERED_APP && METERED_SECRET_KEY && typeof fetch === 'function') {
    try {
      const res = await fetch(
        `https://${METERED_APP}.metered.live/api/v1/turn/credential?secretKey=${encodeURIComponent(METERED_SECRET_KEY)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiryInSeconds: TURN_TTL_SECONDS, label: 'session' }),
          signal: AbortSignal.timeout(5000)
        }
      );

      if (res.ok) {
        const data = await res.json();
        if (data.username && data.password) {
          return buildIceServers(data.username, data.password);
        }
      }

      console.error('Metered credential request failed, status:', res.status);
    } catch (error) {
      console.error('Metered credential request error:', error.message);
    }
  }

  if (TURN_USERNAME && TURN_CREDENTIAL) {
    return buildIceServers(TURN_USERNAME, TURN_CREDENTIAL);
  }

  console.error('No TURN credentials available; using STUN only.');
  return STUN_ONLY;
}

const wss = new WebSocket.Server({
  port: PORT,
  maxPayload: MAX_PAYLOAD,
  verifyClient: (info) => {
    if (ALLOWED_ORIGINS.length === 0) return true;
    return ALLOWED_ORIGINS.includes(info.origin);
  }
});

// code -> { host, controller, pending, createdAt, approvalTimer }
const sessions = new Map();
const connectionsPerIp = new Map();
const failedJoins = new Map(); // ip -> { count, first, blockedUntil }

console.log(`Signaling server running on port ${PORT}`);

// ============================
// HELPERS
// ============================

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function generateSessionCode() {
  let code;
  do {
    code = crypto.randomInt(100000, 1000000).toString();
  } while (sessions.has(code));
  return code;
}

function isBlocked(ip) {
  const rec = failedJoins.get(ip);
  return !!rec && rec.blockedUntil > Date.now();
}

function recordFailedJoin(ip) {
  const now = Date.now();
  let rec = failedJoins.get(ip);

  if (!rec || now - rec.first > FAIL_WINDOW_MS) {
    rec = { count: 0, first: now, blockedUntil: 0 };
    failedJoins.set(ip, rec);
  }

  rec.count++;

  if (rec.count >= MAX_FAILED_JOINS) {
    rec.blockedUntil = now + BLOCK_MS;
  }

  return rec.blockedUntil > now;
}

function clearPending(session, message) {
  if (session.approvalTimer) {
    clearTimeout(session.approvalTimer);
    session.approvalTimer = null;
  }

  const pending = session.pending;
  session.pending = null;

  if (pending) {
    pending.sessionCode = null;
    pending.role = null;
    if (message) {
      send(pending, { type: 'error', message });
    }
  }
}

// Ends a session and tells everyone still in it
function closeSession(code, hostMessage, controllerMessage) {
  const session = sessions.get(code);
  if (!session) return;

  clearPending(session, controllerMessage);

  if (session.controller) {
    if (controllerMessage) {
      send(session.controller, { type: 'error', message: controllerMessage });
    }
    session.controller.sessionCode = null;
    session.controller.role = null;
  }

  if (session.host) {
    if (hostMessage) {
      send(session.host, { type: 'error', message: hostMessage });
    }
    session.host.sessionCode = null;
    session.host.role = null;
  }

  sessions.delete(code);
  console.log('Session closed');
}

// ============================
// CONNECTIONS
// ============================

wss.on('connection', (ws, req) => {
  const ip = getIP(req);
  const count = connectionsPerIp.get(ip) || 0;

  if (count >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, 'Too many connections');
    return;
  }

  connectionsPerIp.set(ip, count + 1);

  ws.ip = ip;
  ws.sessionCode = null;
  ws.role = null;           // 'host' | 'pending' | 'controller'
  ws.isAlive = true;
  ws.failedJoins = 0;
  ws.msgCount = 0;
  ws.msgWindowStart = Date.now();

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {

    // Per-connection message rate limit
    const now = Date.now();
    if (now - ws.msgWindowStart > MSG_WINDOW_MS) {
      ws.msgWindowStart = now;
      ws.msgCount = 0;
    }
    ws.msgCount++;
    if (ws.msgCount > MSG_LIMIT) {
      send(ws, { type: 'error', message: 'Too many messages.' });
      ws.close(1008, 'Rate limit');
      return;
    }

    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      send(ws, { type: 'error', message: 'Invalid JSON message.' });
      return;
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send(ws, { type: 'error', message: 'Invalid message.' });
      return;
    }

    // ============================
    // CREATE SESSION (host)
    // ============================

    if (message.action === 'create-session') {

      if (ws.sessionCode) {
        send(ws, { type: 'error', message: 'Already in a session.' });
        return;
      }

      if (sessions.size >= MAX_SESSIONS) {
        send(ws, { type: 'error', message: 'Server busy. Try again later.' });
        return;
      }

      const code = generateSessionCode();

      const session = {
        host: ws,
        controller: null,
        pending: null,
        createdAt: Date.now(),
        approvalTimer: null,
        iceServers: STUN_ONLY
      };

      sessions.set(code, session);

      ws.sessionCode = code;
      ws.role = 'host';

      getIceServers().then((iceServers) => {
        session.iceServers = iceServers;
        send(ws, { type: 'session-created', code: code, iceServers: iceServers });
      });

      console.log('Session created');
      return;
    }

    // ============================
    // JOIN SESSION (controller requests, host must approve)
    // ============================

    if (message.action === 'join-session') {

      if (ws.sessionCode) {
        send(ws, { type: 'error', message: 'Already in a session.' });
        return;
      }

      if (isBlocked(ws.ip)) {
        send(ws, { type: 'error', message: 'Too many attempts. Try again later.' });
        return;
      }

      const code = String(message.code || '');
      const session = /^\d{6}$/.test(code) ? sessions.get(code) : null;

      // Same message for "wrong code" and "session busy" so codes can't be probed
      if (!session || session.controller || session.pending) {
        recordFailedJoin(ws.ip);
        ws.failedJoins++;

        send(ws, { type: 'error', message: 'Session not found or unavailable.' });

        if (ws.failedJoins >= MAX_FAILED_JOINS) {
          ws.close(1008, 'Too many attempts');
        }
        return;
      }

      session.pending = ws;
      ws.sessionCode = code;
      ws.role = 'pending';

      send(ws, { type: 'join-pending' });
      send(session.host, { type: 'controller-request' });

      session.approvalTimer = setTimeout(() => {
        clearPending(session, 'Host did not respond.');
      }, APPROVAL_TIMEOUT_MS);

      console.log('Controller waiting for approval');
      return;
    }

    // ============================
    // HOST DECISION
    // ============================

    if (message.action === 'approve-controller' || message.action === 'reject-controller') {

      if (ws.role !== 'host') {
        send(ws, { type: 'error', message: 'Not allowed.' });
        return;
      }

      const session = sessions.get(ws.sessionCode);

      if (!session || !session.pending) {
        send(ws, { type: 'error', message: 'No controller is waiting.' });
        return;
      }

      if (message.action === 'reject-controller') {
        clearPending(session, 'Host declined the connection.');
        console.log('Controller rejected');
        return;
      }

      // Approve
      if (session.approvalTimer) {
        clearTimeout(session.approvalTimer);
        session.approvalTimer = null;
      }

      const controller = session.pending;
      session.pending = null;
      session.controller = controller;
      controller.role = 'controller';

      send(controller, { type: 'session-joined', code: ws.sessionCode, iceServers: session.iceServers });
      send(ws, { type: 'controller-joined', code: ws.sessionCode });

      console.log('Controller approved');
      return;
    }

    // ============================
    // WEBRTC SIGNALING
    // ============================

    if (message.action === 'signal') {

      // The session comes from the connection itself, never from the message
      const session = sessions.get(ws.sessionCode);

      if (!session || (ws.role !== 'host' && ws.role !== 'controller')) {
        send(ws, { type: 'error', message: 'Not in a session.' });
        return;
      }

      const target = ws.role === 'host' ? session.controller : session.host;

      if (!target) {
        send(ws, { type: 'error', message: 'Peer is not connected.' });
        return;
      }

      const payload = message.payload;

      if (!payload || typeof payload !== 'object' || !SIGNAL_TYPES.has(payload.type)) {
        send(ws, { type: 'error', message: 'Invalid signal.' });
        return;
      }

      send(target, { type: 'signal', data: payload });
      return;
    }

    // ============================
    // UNKNOWN ACTION
    // ============================

    send(ws, { type: 'error', message: 'Unknown action.' });
  });

  // ============================
  // DISCONNECT
  // ============================

  ws.on('close', () => {
    const remaining = (connectionsPerIp.get(ws.ip) || 1) - 1;
    if (remaining <= 0) {
      connectionsPerIp.delete(ws.ip);
    } else {
      connectionsPerIp.set(ws.ip, remaining);
    }

    const code = ws.sessionCode;
    if (!code) return;

    const session = sessions.get(code);
    if (!session) return;

    if (ws.role === 'host') {
      closeSession(code, null, 'Host disconnected.');
    } else if (ws.role === 'controller') {
      // Sessions are single-use: when the controller leaves, the host starts a new one
      closeSession(code, 'Controller disconnected.', null);
    } else if (ws.role === 'pending') {
      if (session.pending === ws) {
        ws.sessionCode = null;
        ws.role = null;
        session.pending = null;
        if (session.approvalTimer) {
          clearTimeout(session.approvalTimer);
          session.approvalTimer = null;
        }
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});

// ============================
// BACKGROUND CLEANUP
// ============================

// Drop dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

// Expire sessions nobody joined, and forget old failed-attempt records
setInterval(() => {
  const now = Date.now();

  for (const [code, session] of sessions) {
    if (!session.controller && now - session.createdAt > WAITING_SESSION_TTL_MS) {
      closeSession(code, 'Session expired. Generate a new code.', null);
    }
  }

  for (const [ip, rec] of failedJoins) {
    if (rec.blockedUntil < now && now - rec.first > FAIL_WINDOW_MS) {
      failedJoins.delete(ip);
    }
  }
}, 30 * 1000);
