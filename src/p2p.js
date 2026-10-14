// Módulo WebRTC P2P de Rastreamento Direto em Tempo Real com PeerJS
import { Peer } from 'peerjs';
import mqtt from 'mqtt';
import { state, saveMembersToStorage } from './sync.js';

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
  const circleKey = state.circleId.replace(/[^a-zA-Z0-9]/g, '') || 'FAMILIA01';
  const myShortId = state.currentUser.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6);

  // Sufixo único por sessão para evitar colisões no servidor público PeerJS ao recarregar a página
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
      console.log('[P2P] Nó ativo conectado à rede com ID:', assignedId);

      // Conexão automática caso a URL contenha o nó que gerou o convite/QR Code
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
      // Se ID já estiver reservado no servidor, conecta com ID dinâmico livre
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
    broadcastRingDevice: (targetId) => sendP2PBroadcast({ type: 'RING_DEVICE', targetId, senderName: state.currentUser.name, senderId: state.currentUser.id }),
    connectTo: (peerId) => connectToRemotePeer(peerId, handlers),
    getConnectionCount: () => activeConnections.size,
  };
}

/**
 * Conecta ativamente a outro dispositivo via WebRTC
 */
export function connectToRemotePeer(targetPeerId, handlers, retryCount = 0) {
  if (!peerInstance || !targetPeerId || activeConnections.has(targetPeerId)) return;

  try {
    const conn = peerInstance.connect(targetPeerId, {
      reliable: true,
    });

    if (conn) {
      setupConnectionEvents(conn, handlers);

      // Tenta uma reconexão preventiva após 3.5s se não abrir de primeira
      setTimeout(() => {
        if (!activeConnections.has(targetPeerId) && retryCount < 2) {
          console.log('[P2P] Tentando conectar novamente ao peer:', targetPeerId);
          connectToRemotePeer(targetPeerId, handlers, retryCount + 1);
        }
      }, 3500);
    }
  } catch (e) {
    console.warn('[P2P] Falha ao iniciar conexão:', e);
  }
}

/**
 * Configura eventos do canal de dados WebRTC bidirecional
 */
function setupConnectionEvents(conn, handlers = {}) {
  const { onPeerConnected, onPeerDisconnected, onLocationReceived, onSOSReceived, onRingReceived, onPingUpdated } = handlers;
  conn.on('open', () => {
    activeConnections.set(conn.peer, conn);
    console.log('[P2P] Canal conectado com:', conn.peer);

    // Envia apresentação inicial e posição GPS atualizada
    conn.send({
      type: 'HANDSHAKE',
      user: state.currentUser,
      ts: Date.now(),
    });
    conn.send({
      type: 'LOCATION',
      data: state.currentUser,
    });

    if (onPeerConnected) {
      onPeerConnected(conn.peer);
    }

    // Ping periódico para monitorar latência em milissegundos
    const pingInterval = setInterval(() => {
      if (conn.open) {
        conn.send({ type: 'PING', start: Date.now() });
      } else {
        clearInterval(pingInterval);
      }
    }, 5000);
  });

  conn.on('data', (payload) => {
    if (!payload) return;

    if (payload.type === 'HANDSHAKE' && payload.user) {
      const isNew = !state.members.has(payload.user.id);
      // Registra o outro aparelho como membro real ativo no círculo
      state.members.set(payload.user.id, {
        ...payload.user,
        peerId: conn.peer,
        isMe: false,
        isP2P: true,
        isDemo: false,
      });
      saveMembersToStorage();

      // Retribui a posição atualizada imediatamente
      conn.send({ type: 'LOCATION', data: state.currentUser });
      if (onLocationReceived) onLocationReceived(payload.user);
      if (isNew && onPeerConnected) onPeerConnected(payload.user);
    } else if (payload.type === 'LOCATION' && payload.data) {
      // Atualização contínua de posição de quem está se movimentando
      state.members.set(payload.data.id, {
        ...payload.data,
        peerId: conn.peer,
        isMe: false,
        isP2P: true,
        isDemo: false,
      });
      saveMembersToStorage();
      if (onLocationReceived) onLocationReceived(payload.data);
    } else if (payload.type === 'SOS') {
      console.warn('[P2P] Alerta SOS recebido:', payload);
      if (onSOSReceived) onSOSReceived(payload);
    } else if (payload.type === 'RING_DEVICE') {
      console.log('[P2P] Alerta sonoro de localização recebido:', payload);
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
    console.log('[P2P] Conexão encerrada com:', conn.peer);
    if (onPeerDisconnected) onPeerDisconnected(conn.peer);

    // Reconexão automática em caso de oscilação do 4G
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
      console.log('[P2P] Tentando reconectar automaticamente ao nó:', peerId);
      connectToRemotePeer(peerId, handlers);
    }
  }, 4000);
}

/**
 * Transmite uma mensagem para todos os aparelhos conectados via WebRTC
 */
function sendP2PBroadcast(message) {
  activeConnections.forEach((conn) => {
    if (conn.open) {
      try {
        conn.send(message);
      } catch (e) {
        console.warn('[P2P Send Error]', e);
      }
    }
  });
}
