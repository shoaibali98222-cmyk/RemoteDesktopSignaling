let currentRole = 'host';
let peerConnection = null;
let dataChannel = null;
let sessionCode = null;
let socket = null;
let localStream = null;

let iceCandidateQueue = [];

const SIGNALING_URL = 'wss://remote-desktop-signaling-hexa.onrender.com';

const rtcConfig = {
  iceServers: [
    {
      urls: "stun:stun.relay.metered.ca:80",
    },
    {
      urls: "turn:global.relay.metered.ca:80",
      username: "a40314b607be1f6f8bc4cd35",
      credential: "Ad8AX7aGgHPlUZ8v",
    },
    {
      urls: "turn:global.relay.metered.ca:80?transport=tcp",
      username: "a40314b607be1f6f8bc4cd35",
      credential: "Ad8AX7aGgHPlUZ8v",
    },
    {
      urls: "turn:global.relay.metered.ca:443",
      username: "a40314b607be1f6f8bc4cd35",
      credential: "Ad8AX7aGgHPlUZ8v",
    },
    {
      urls: "turns:global.relay.metered.ca:443?transport=tcp",
      username: "a40314b607be1f6f8bc4cd35",
      credential: "Ad8AX7aGgHPlUZ8v",
    },
  ]
};

// ===============================
// UI Controls
// ===============================

function selectRole(role) {
  currentRole = role;

  const hostBtn = document.getElementById('hostRoleBtn');
  const controllerBtn = document.getElementById('controllerRoleBtn');
  const hostInputs = document.getElementById('hostInputs');
  const controllerInputs = document.getElementById('controllerInputs');

  if (role === 'host') {
    hostBtn.classList.add('active');
    controllerBtn.classList.remove('active');

    hostInputs.classList.remove('hidden');
    controllerInputs.classList.add('hidden');
  } else {
    controllerBtn.classList.add('active');
    hostBtn.classList.remove('active');

    controllerInputs.classList.remove('hidden');
    hostInputs.classList.add('hidden');
  }
}

function updateStatus(text, stateClass) {
  const badge = document.getElementById('statusBadge');

  badge.textContent = `● ${text}`;
  badge.className = `status ${stateClass}`;
}

// ===============================
// Signaling
// ===============================

function connectSignaling(onOpenCallback) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    onOpenCallback();
    return;
  }

  socket = new WebSocket(SIGNALING_URL);

  socket.onopen = () => {
    console.log('Connected to signaling server');
    onOpenCallback();
  };

  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleSignalingMessage(message);
    } catch (error) {
      console.error('Invalid server message:', error);
    }
  };

  socket.onerror = (error) => {
    console.error('Signaling error:', error);
    updateStatus('Server Offline', 'offline');
  };

  socket.onclose = () => {
    console.log('Disconnected from signaling server');
  };
}

function sendSignal(action, payload = {}) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        action,
        code: sessionCode,
        ...payload
      })
    );
  }
}

// ===============================
// Host
// ===============================

async function startHost() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });
  } catch (error) {
    console.error('Screen sharing cancelled:', error);

    alert('Screen sharing permission is required to act as Host.');
    return;
  }

  connectSignaling(() => {
    sendSignal('create-session');
  });
}

// ===============================
// Controller
// ===============================

function connectController() {
  const codeInput = document
    .getElementById('joinCode')
    .value
    .trim();

  if (!/^\d{6}$/.test(codeInput)) {
    alert('Please enter a valid 6-digit session code.');
    return;
  }

  sessionCode = codeInput;

  updateStatus('Connecting...', 'waiting');

  connectSignaling(() => {
    sendSignal('join-session');
  });
}

// ===============================
// WebRTC
// ===============================

function initPeerConnection() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  iceCandidateQueue = [];

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal('signal', {
        payload: {
          type: 'candidate',
          candidate: event.candidate
        }
      });
    }
  };

  peerConnection.ontrack = (event) => {
    const videoElem = document.getElementById('remoteVideo');
    const placeholder = document.getElementById('screenPlaceholder');

    if (event.streams && event.streams[0]) {
      videoElem.srcObject = event.streams[0];

      videoElem.classList.remove('hidden');
      placeholder.classList.add('hidden');
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log(
      'WebRTC connection:',
      peerConnection.connectionState
    );

    if (peerConnection.connectionState === 'connected') {
      updateStatus('Connected', 'connected');

      document
        .getElementById('roleView')
        .classList.add('hidden');

      document
        .getElementById('screenView')
        .classList.remove('hidden');

      document.getElementById(
        'screenLabel'
      ).textContent = `Session [${sessionCode}]`;
    }

    if (
      peerConnection.connectionState === 'failed' ||
      peerConnection.connectionState === 'disconnected'
    ) {
      updateStatus('Connection Lost', 'offline');
    }
  };
}

// ===============================
// Data Channel
// ===============================

function setupDataChannel(channel) {
  dataChannel = channel;

  dataChannel.onopen = () => {
    console.log('DataChannel opened');
  };

  dataChannel.onclose = () => {
    console.log('DataChannel closed');
  };

  dataChannel.onerror = (error) => {
    console.error('DataChannel error:', error);
  };

  // ===============================
  // RECEIVE CONTROLLER INPUT
  // ===============================

  dataChannel.onmessage = (event) => {
    try {
      const gesture = JSON.parse(event.data);

      console.log(
        'Received controller input:',
        gesture
      );

      // Send MOVE and TAP to RobotJS bridge
      if (
        currentRole === 'host' &&
        (gesture.type === 'MOVE' ||
         gesture.type === 'TAP')
      ) {
        fetch('http://localhost:3001/input', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(gesture)
        })
          .then(() => {
            console.log(
              `${gesture.type} sent to RobotJS bridge`
            );
          })
          .catch((error) => {
            console.error(
              'Input bridge error:',
              error
            );
          });
      }

      // Future Android/WebView bridge
      if (
        window.AndroidBridge &&
        window.AndroidBridge.onGestureReceived
      ) {
        window.AndroidBridge.onGestureReceived(
          event.data
        );
      }

    } catch (error) {
      console.error(
        'Invalid DataChannel message:',
        error
      );
    }
  };
}

// ===============================
// Signaling Message Handler
// ===============================

async function handleSignalingMessage(message) {
  switch (message.type) {

    case 'session-created':

      sessionCode = message.code;

      document.getElementById(
        'hostCode'
      ).textContent = sessionCode;

      updateStatus(
        'Waiting for Controller...',
        'waiting'
      );

      initPeerConnection();

      // Add host screen tracks
      if (localStream) {
        localStream
          .getTracks()
          .forEach((track) => {
            peerConnection.addTrack(
              track,
              localStream
            );
          });
      }

      // Create control channel
      dataChannel =
        peerConnection.createDataChannel(
          'touchEvents'
        );

      setupDataChannel(dataChannel);

      break;

    case 'controller-joined':

      await createOffer();

      break;

    case 'session-joined':

      initPeerConnection();

      peerConnection.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };

      break;

    case 'signal': {

      const data = message.data;

      if (!data) {
        return;
      }

      if (data.type === 'offer') {
        await handleOffer(data.sdp);
      }

      else if (data.type === 'answer') {
        await handleAnswer(data.sdp);
      }

      else if (data.type === 'candidate') {
        await handleCandidate(data.candidate);
      }

      break;
    }

    case 'error':

      alert(message.message);

      updateStatus(
        'Offline',
        'offline'
      );

      break;

    default:

      console.log(
        'Unknown server message:',
        message
      );
  }
}

// ===============================
// SDP Negotiation
// ===============================

async function createOffer() {

  if (!peerConnection) {
    console.error(
      'Cannot create offer: peer connection missing.'
    );
    return;
  }

  const offer =
    await peerConnection.createOffer();

  await peerConnection.setLocalDescription(
    offer
  );

  sendSignal('signal', {
    payload: {
      type: 'offer',
      sdp: offer
    }
  });
}

async function handleOffer(sdp) {

  if (!peerConnection) {
    return;
  }

  await peerConnection.setRemoteDescription(
    new RTCSessionDescription(sdp)
  );

  await processIceCandidateQueue();

  const answer =
    await peerConnection.createAnswer();

  await peerConnection.setLocalDescription(
    answer
  );

  sendSignal('signal', {
    payload: {
      type: 'answer',
      sdp: answer
    }
  });
}

async function handleAnswer(sdp) {

  if (!peerConnection) {
    return;
  }

  await peerConnection.setRemoteDescription(
    new RTCSessionDescription(sdp)
  );

  await processIceCandidateQueue();
}

// ===============================
// ICE Candidates
// ===============================

async function handleCandidate(candidate) {

  if (!peerConnection || !candidate) {
    return;
  }

  try {

    if (peerConnection.remoteDescription) {

      await peerConnection.addIceCandidate(
        new RTCIceCandidate(candidate)
      );

    } else {

      iceCandidateQueue.push(candidate);

    }

  } catch (error) {

    console.error(
      'Error adding ICE candidate:',
      error
    );

  }
}

async function processIceCandidateQueue() {

  if (!peerConnection) {
    return;
  }

  while (iceCandidateQueue.length > 0) {

    const candidate =
      iceCandidateQueue.shift();

    try {

      await peerConnection.addIceCandidate(
        new RTCIceCandidate(candidate)
      );

    } catch (error) {

      console.error(
        'Error processing queued ICE candidate:',
        error
      );

    }
  }
}

// ===============================
// Controller Mouse Movement + Click
// ===============================

const remoteVideo =
  document.getElementById('remoteVideo');

if (remoteVideo) {

  // Mouse movement
  remoteVideo.addEventListener(
    'mousemove',
    (event) => {

      if (
        currentRole !== 'controller' ||
        !dataChannel ||
        dataChannel.readyState !== 'open'
      ) {
        return;
      }

      const rect =
        remoteVideo.getBoundingClientRect();

      const normX =
        (event.clientX - rect.left) /
        rect.width;

      const normY =
        (event.clientY - rect.top) /
        rect.height;

      dataChannel.send(
        JSON.stringify({
          type: 'MOVE',
          x: Number(normX.toFixed(4)),
          y: Number(normY.toFixed(4))
        })
      );
    }
  );

  // Mouse click
  remoteVideo.addEventListener(
    'click',
    (event) => {

      if (
        currentRole !== 'controller' ||
        !dataChannel ||
        dataChannel.readyState !== 'open'
      ) {
        return;
      }

      const rect =
        remoteVideo.getBoundingClientRect();

      const normX =
        (event.clientX - rect.left) /
        rect.width;

      const normY =
        (event.clientY - rect.top) /
        rect.height;

      dataChannel.send(
        JSON.stringify({
          type: 'TAP',
          x: Number(normX.toFixed(4)),
          y: Number(normY.toFixed(4))
        })
      );

      console.log(
        'Sent TAP:',
        normX,
        normY
      );
    }
  );
}

// ===============================
// Disconnect
// ===============================

function disconnect() {

  iceCandidateQueue = [];

  if (localStream) {

    localStream
      .getTracks()
      .forEach((track) => track.stop());

    localStream = null;
  }

  if (dataChannel) {

    dataChannel.close();
    dataChannel = null;
  }

  if (peerConnection) {

    peerConnection.close();
    peerConnection = null;
  }

  if (socket) {

    socket.close();
    socket = null;
  }

  updateStatus(
    'Offline',
    'offline'
  );

  document
    .getElementById('roleView')
    .classList.remove('hidden');

  document
    .getElementById('screenView')
    .classList.add('hidden');

  document.getElementById(
    'hostCode'
  ).textContent = '------';

  document.getElementById(
    'joinCode'
  ).value = '';

  document.getElementById(
    'remoteVideo'
  ).srcObject = null;

  sessionCode = null;
}