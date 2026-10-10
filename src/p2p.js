// Módulo WebRTC P2P de Rastreamento Direto em Tempo Real com PeerJS
import { Peer } from 'peerjs';
import { state } from './sync.js';

let peerInstance = null;
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
export function initP2PNetwork({ onPeerConnected, onPeerDisconnected, onLocationReceived, onPingUpdated }) {
  // Gera ID único amigável do nó P2P
  const myShortId = state.currentUser.id.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
  const myPeerId = `gp_${state.circleId.replace(/[^a-zA-Z0-9]/g, '')}_${myShortId}`;

  // Configuração com servidores públicos STUN do Google para atravessar 4G/NAT de operadoras
  peerInstance = new Peer(myPeerId, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
    },
    debug: 1,
  });

  peerInstance.on('open', (id) => {
    console.log('[P2P] Nó ativo com ID:', id);

    // Verifica se a URL contém um peer para conectar automaticamente (ex: escaneou QR no celular)
    const urlParams = new URLSearchParams(window.location.search);
    const targetPeer = urlParams.get('peer');

    if (targetPeer && targetPeer !== id) {
      connectToRemotePeer(targetPeer, {
        onPeerConnected,
        onPeerDisconnected,
        onLocationReceived,
        onPingUpdated,
      });
    }
  });

  // Recebe conexões de outros aparelhos (ex: celular conectando ao PC)
  peerInstance.on('connection', (conn) => {
    setupConnectionEvents(conn, {
      onPeerConnected,
      onPeerDisconnected,
      onLocationReceived,
      onPingUpdated,
    });
  });

  peerInstance.on('error', (err) => {
    console.warn('[P2P Error]', err);
  });

  // Tenta manter a tela acesa se for dispositivo móvel
  enableScreenWakeLock();

  return {
    getMyPeerId: () => peerInstance?.id || myPeerId,
    broadcastPosition: (userData) => sendP2PBroadcast({ type: 'LOCATION', data: userData }),
    broadcastSOS: (sosData) => sendP2PBroadcast({ type: 'SOS', data: sosData }),
    connectTo: (peerId) =>
      connectToRemotePeer(peerId, {
        onPeerConnected,
        onPeerDisconnected,
        onLocationReceived,
        onPingUpdated,
      }),
    getConnectionCount: () => activeConnections.size,
  };
}

/**
 * Conecta ativamente a outro dispositivo via WebRTC
 */
export function connectToRemotePeer(targetPeerId, handlers) {
  if (!peerInstance || activeConnections.has(targetPeerId)) return;

  const conn = peerInstance.connect(targetPeerId, {
    reliable: true,
  });

  setupConnectionEvents(conn, handlers);
}

/**
 * Configura eventos do canal de dados WebRTC bidirecional
 */
function setupConnectionEvents(conn, { onPeerConnected, onPeerDisconnected, onLocationReceived, onPingUpdated }) {
  conn.on('open', () => {
    activeConnections.set(conn.peer, conn);
    console.log('[P2P] Canal conectado com:', conn.peer);

    // Envia apresentação inicial
    conn.send({
      type: 'HANDSHAKE',
      user: state.currentUser,
      ts: Date.now(),
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
      // Registra o outro aparelho como membro ativo
      state.members.set(payload.user.id, {
        ...payload.user,
        peerId: conn.peer,
        isMe: false,
        isP2P: true,
      });
      // Retribui a posição atual
      conn.send({ type: 'LOCATION', data: state.currentUser });
      if (onLocationReceived) onLocationReceived(payload.user);
    } else if (payload.type === 'LOCATION' && payload.data) {
      // Atualização contínua de posição de quem está na rua
      state.members.set(payload.data.id, {
        ...payload.data,
        peerId: conn.peer,
        isMe: false,
        isP2P: true,
      });
      if (onLocationReceived) onLocationReceived(payload.data);
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
    attemptAutoReconnect(conn.peer, { onPeerConnected, onPeerDisconnected, onLocationReceived, onPingUpdated });
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
      } catch (err) {
        console.debug('Falha ao enviar pacote P2P:', err);
      }
    }
  });
}
