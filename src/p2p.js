// Módulo WebRTC P2P de Rastreamento Direto em Tempo Real com PeerJS e Criptografia E2E
import { Peer } from 'peerjs';
import { state, saveMembersToStorage, mergeRemoteMember } from './sync.js';
import { encryptPayload, decryptPayload } from './crypto.js';

let peerInstance = null;
let activeLivePeerId = '';
const activeConnections = new Map(); // peerId -> DataConnection
let wakeLockSentinel = null;
let reconnectTimer = null;

/**
 * Ativa a Wake Lock API para impedir que a tela do celular apague durante o deslocamento
 */
export async function enableScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
      });
      console.log('Screen Wake Lock ativo.');
    } catch (err) {
      console.debug('Wake Lock não autorizado ou indisponível:', err);
    }
  }
}

/**
 * Inicializa a rede P2P WebRTC para o círculo
 */
export function initP2PNetwork({ onPeerConnected, onPeerDisconnected, onLocationReceived, onSOSReceived, onRingReceived, onPingUpdated }) {
  const handlers = { onPeerConnected, onPeerDisconnected, onLocationReceived, onSOSReceived, onRingReceived, onPingUpdated };
  const circleKey = (state.circleId.replace(/[^a-zA-Z0-9]/g, '') || 'FAMILIA01').slice(0, 16);
  const myShortId = state.currentUser.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6);

  let sessionToken = '';
  try {
    sessionToken = sessionStorage.getItem('geopulse_p2p_sess') || Math.random().toString(36).slice(2, 6);
    sessionStorage.setItem('geopulse_p2p_sess', sessionToken);
  } catch (e) {
    sessionToken = Math.random().toString(36).slice(2, 6);
  }

  const myPeerId = `gp_${circleKey}_${myShortId}_${sessionToken}`;

  const peerConfig = {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
    },
    debug: 1,
  };

  const createPeer = (id) => {
    const peer = id ? new Peer(id, peerConfig) : new Peer(peerConfig);

    peer.on('open', (assignedId) => {
      activeLivePeerId = assignedId;
      console.log('[P2P] Nó ativo conectado com ID:', assignedId);

      if (typeof window !== 'undefined' && window.location.search) {
        const urlParams = new URLSearchParams(window.location.search);
        const targetPeer = urlParams.get('peer');

        if (targetPeer && targetPeer !== assignedId) {
          setTimeout(() => {
            connectToRemotePeer(targetPeer, handlers);
          }, 600);
        }
      }
    });

    peer.on('connection', (conn) => {
      setupConnectionEvents(conn, handlers);
    });

    peer.on('error', (err) => {
      console.warn('[P2P Error]', err);
      if (err.type === 'unavailable-id') {
        try {
          peer.destroy();
        } catch (e) {}
        peerInstance = createPeer(null);
      }
    });

    return peer;
  };

  peerInstance = createPeer(myPeerId);
  enableScreenWakeLock();

  return {
    getMyPeerId: () => activeLivePeerId || peerInstance?.id || myPeerId,
    broadcastPosition: (userData) => sendP2PBroadcast({ type: 'LOCATION', data: userData }),
    broadcastSOS: (sosData) => sendP2PBroadcast({ type: 'SOS', user: state.currentUser, data: sosData }),
    broadcastRingDevice: (targetId) =>
      sendP2PBroadcast({
        type: 'RING_DEVICE',
        targetId,
        senderName: state.currentUser.name,
        senderId: state.currentUser.id,
      }),
    broadcastMemberDeleted: (memberId) =>
      sendP2PBroadcast({ type: 'MEMBER_DELETED', memberId, senderId: state.currentUser.id }),
    connectTo: (peerId) => connectToRemotePeer(peerId, handlers),
    getConnectionCount: () => activeConnections.size,
  };
}

export function connectToRemotePeer(targetPeerId, handlers, retryCount = 0) {
  if (!peerInstance || !targetPeerId || activeConnections.has(targetPeerId)) return;

  try {
    const conn = peerInstance.connect(targetPeerId, {
      reliable: true,
    });

    if (conn) {
      setupConnectionEvents(conn, handlers);

      setTimeout(() => {
        if (!activeConnections.has(targetPeerId) && retryCount < 2) {
          connectToRemotePeer(targetPeerId, handlers, retryCount + 1);
        }
      }, 3500);
    }
  } catch (e) {
    console.warn('[P2P] Falha ao iniciar conexão:', e);
  }
}

function setupConnectionEvents(conn, handlers = {}) {
  const { onPeerConnected, onPeerDisconnected, onLocationReceived, onSOSReceived, onRingReceived, onPingUpdated } = handlers;

  conn.on('open', async () => {
    activeConnections.set(conn.peer, conn);
    console.log('[P2P] Canal conectado com:', conn.peer);

    let isNewInvite = false;
    try {
      isNewInvite = sessionStorage.getItem('geopulse_is_new_join') === 'true';
    } catch (e) {}

    const handshakePayload = await encryptPayload({
      type: 'HANDSHAKE',
      user: state.currentUser,
      isNewInvite,
      ts: Date.now(),
    });
    conn.send(handshakePayload);

    const locationPayload = await encryptPayload({
      type: 'LOCATION',
      data: state.currentUser,
    });
    conn.send(locationPayload);

    if (onPeerConnected) {
      onPeerConnected(conn.peer, false);
    }

    const pingInterval = setInterval(() => {
      if (conn.open) {
        conn.send({ type: 'PING', start: Date.now() });
      } else {
        clearInterval(pingInterval);
      }
    }, 5000);
  });

  conn.on('data', async (rawPayload) => {
    if (!rawPayload) return;

    // Decifra envelope E2E
    const payload = await decryptPayload(rawPayload);
    if (!payload) return;

    if (payload.type === 'HANDSHAKE' && payload.user) {
      const isKnown = state.members.has(payload.user.id);
      mergeRemoteMember({
        ...payload.user,
        peerId: conn.peer,
        isP2P: true,
      });

      // Retribui a posição atualizada imediatamente
      encryptPayload({ type: 'LOCATION', data: state.currentUser }).then((enc) => conn.send(enc));

      if (onLocationReceived) onLocationReceived(payload.user);
      const isFirstTimeInvite = !!payload.isNewInvite && !isKnown;
      if (onPeerConnected) onPeerConnected(payload.user, isFirstTimeInvite);
    } else if (payload.type === 'LOCATION' && payload.data) {
      mergeRemoteMember({
        ...payload.data,
        peerId: conn.peer,
        isP2P: true,
      });
      if (onLocationReceived) onLocationReceived(payload.data);
    } else if (payload.type === 'SOS') {
      if (onSOSReceived) onSOSReceived(payload);
    } else if (payload.type === 'MEMBER_DELETED' && payload.memberId) {
      state.members.delete(payload.memberId);
      saveMembersToStorage();
      if (onPeerDisconnected) onPeerDisconnected(payload.memberId);
    } else if (payload.type === 'RING_DEVICE') {
      if (onRingReceived) onRingReceived(payload);
    } else if (payload.type === 'PING') {
      conn.send({ type: 'PONG', start: payload.start });
    } else if (payload.type === 'PONG') {
      const rtt = Date.now() - payload.start;
      if (onPingUpdated) onPingUpdated(conn.peer, rtt);
    }
  });

  conn.on('close', () => {
    activeConnections.delete(conn.peer);
    if (onPeerDisconnected) onPeerDisconnected(conn.peer);
    attemptAutoReconnect(conn.peer, handlers);
  });

  conn.on('error', (err) => {
    console.warn('[P2P Conn Error]', err);
  });
}

function attemptAutoReconnect(peerId, handlers) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (peerInstance && !activeConnections.has(peerId)) {
      connectToRemotePeer(peerId, handlers);
    }
  }, 4000);
}

async function sendP2PBroadcast(message) {
  const encMessage = await encryptPayload(message);
  activeConnections.forEach((conn) => {
    if (conn.open) {
      try {
        conn.send(encMessage);
      } catch (e) {
        console.warn('[P2P Send Error]', e);
      }
    }
  });
}
