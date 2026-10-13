// Módulo de Sincronização em Tempo Real de Alta Performance (MQTT over Secure WebSocket)
// Funciona 100% em qualquer celular (4G, 5G, Wi-Fi, CGNAT, iOS Safari, Android Chrome)
import mqtt from 'mqtt';
import { state, saveMembersToStorage } from './sync.js';

let mqttClient = null;
let currentCircleTopic = '';
let wakeLockSentinel = null;
let heartbeatInterval = null;
let isConnected = false;

// Servidores públicos e confiáveis MQTT over WebSocket (Portas 8884/8084 com SSL)
const PRIMARY_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const FALLBACK_BROKER = 'wss://broker.emqx.io:8084/mqtt';

/**
 * Ativa Screen Wake Lock para manter a transmissão de GPS ativa no celular
 */
export async function enableScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
      });
      console.log('[Realtime] Screen Wake Lock ativo.');
    } catch (err) {
      console.debug('[Realtime] Wake Lock indisponível:', err);
    }
  }
}

/**
 * Retorna dados públicos limpos do usuário atual para transmissão
 */
export function getCleanCurrentUser() {
  return {
    id: state.currentUser.id,
    name: state.currentUser.name,
    relation: state.currentUser.relation || 'Membro',
    role: state.currentUser.role || 'Membro',
    lat: state.currentUser.lat,
    lng: state.currentUser.lng,
    accuracy: state.currentUser.accuracy || 10,
    speed: state.currentUser.speed || 0,
    heading: state.currentUser.heading || 0,
    battery: state.currentUser.battery || 90,
    charging: state.currentUser.charging || false,
    color: state.currentUser.color || '#007AFF',
    avatar: state.currentUser.avatar || 'VC',
    photo: state.currentUser.photo || '',
    activity: state.currentUser.activity || '📍 Parado',
    address: state.currentUser.address || '',
    updatedAt: Date.now(),
    sos: !!state.currentUser.sos,
  };
}

/**
 * Inicializa a sincronização em tempo real entre todos os aparelhos do círculo
 */
export function initRealtimeNetwork({
  onMemberJoined,
  onMemberUpdated,
  onLocationReceived,
  onSOSReceived,
  onStatusChanged,
}) {
  const circleIdSafe = (state.circleId || 'FAMILIA-01').replace(/[^a-zA-Z0-9_-]/g, '');
  currentCircleTopic = `geopulse/v2/${circleIdSafe}`;

  // ID de cliente único para a sessão do celular
  const clientId = `gp_${state.currentUser.id}_${Math.random().toString(36).slice(2, 7)}`;

  console.log(`[Realtime] Conectando ao broker para o círculo ${state.circleId}...`);

  const connectToBroker = (brokerUrl) => {
    try {
      const client = mqtt.connect(brokerUrl, {
        clientId,
        clean: true,
        connectTimeout: 7000,
        reconnectPeriod: 3000,
        keepalive: 30,
      });

      client.on('connect', () => {
        isConnected = true;
        console.log(`[Realtime] Conectado com sucesso via ${brokerUrl}!`);
        if (onStatusChanged) onStatusChanged({ status: 'online', broker: brokerUrl });

        // Inscreve-se nos tópicos de eventos do círculo
        client.subscribe(`${currentCircleTopic}/#`, { qos: 0 }, (err) => {
          if (!err) {
            console.log(`[Realtime] Inscrito no tópico do círculo: ${currentCircleTopic}/#`);

            // Anuncia a entrada do aparelho no círculo
            broadcastJoin();

            // Heartbeat periódico a cada 15 segundos para manter status online
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
              if (isConnected && mqttClient) {
                broadcastPresence();
              }
            }, 15000);
          }
        });
      });

      client.on('message', (topic, rawMessage) => {
        try {
          const payload = JSON.parse(rawMessage.toString());
          if (!payload || !payload.type || !payload.user) return;

          const remoteUser = payload.user;

          // Ignora mensagens originadas do próprio aparelho
          if (remoteUser.id === state.currentUser.id) return;

          const now = Date.now();

          if (payload.type === 'JOIN') {
            console.log('[Realtime] Novo aparelho entrou no círculo:', remoteUser.name);
            state.members.set(remoteUser.id, {
              ...remoteUser,
              isMe: false,
              isOnline: true,
              lastSeen: now,
            });
            saveMembersToStorage();

            if (onMemberJoined) onMemberJoined(remoteUser);

            // Responde imediatamente com a própria presença para o novo aparelho nos registrar
            setTimeout(() => {
              broadcastPresence();
            }, 200);

          } else if (payload.type === 'PRESENCE') {
            const existing = state.members.get(remoteUser.id) || {};
            state.members.set(remoteUser.id, {
              ...existing,
              ...remoteUser,
              isMe: false,
              isOnline: true,
              lastSeen: now,
            });
            saveMembersToStorage();

            if (onMemberUpdated) onMemberUpdated(remoteUser);

          } else if (payload.type === 'LOCATION') {
            const existing = state.members.get(remoteUser.id) || {};
            const updated = {
              ...existing,
              ...remoteUser,
              isMe: false,
              isOnline: true,
              lastSeen: now,
            };
            state.members.set(remoteUser.id, updated);
            saveMembersToStorage();

            if (onLocationReceived) onLocationReceived(updated);

          } else if (payload.type === 'SOS') {
            console.warn('[Realtime] Alerta SOS recebido:', remoteUser.name);
            if (onSOSReceived) onSOSReceived(payload);
          }
        } catch (err) {
          console.warn('[Realtime] Falha ao processar mensagem MQTT:', err);
        }
      });

      client.on('close', () => {
        isConnected = false;
        if (onStatusChanged) onStatusChanged({ status: 'offline' });
      });

      client.on('error', (err) => {
        console.warn('[Realtime Error]', err);
        if (brokerUrl === PRIMARY_BROKER) {
          console.log('[Realtime] Tentando broker de fallback...');
          try {
            client.end(true);
          } catch (e) {}
          mqttClient = connectToBroker(FALLBACK_BROKER);
        }
      });

      return client;
    } catch (e) {
      console.error('[Realtime Init Error]', e);
      return null;
    }
  };

  mqttClient = connectToBroker(PRIMARY_BROKER);
  enableScreenWakeLock();

  return {
    broadcastLocation: (user) => broadcastLocation(user),
    broadcastSOS: (sosData) => broadcastSOS(sosData),
    broadcastJoin: () => broadcastJoin(),
    broadcastPresence: () => broadcastPresence(),
    isConnected: () => isConnected,
  };
}

/**
 * Publica anúncio de entrada no círculo
 */
export function broadcastJoin() {
  if (!mqttClient || !isConnected) return;
  const payload = {
    type: 'JOIN',
    user: getCleanCurrentUser(),
    ts: Date.now(),
  };
  try {
    mqttClient.publish(`${currentCircleTopic}/events`, JSON.stringify(payload));
  } catch (e) {
    console.warn('[Realtime Send Error]', e);
  }
}

/**
 * Publica presença regular para todos os aparelhos saberem que este celular está ativo
 */
export function broadcastPresence() {
  if (!mqttClient || !isConnected) return;
  const payload = {
    type: 'PRESENCE',
    user: getCleanCurrentUser(),
    ts: Date.now(),
  };
  try {
    mqttClient.publish(`${currentCircleTopic}/events`, JSON.stringify(payload));
  } catch (e) {
    console.warn('[Realtime Send Error]', e);
  }
}

/**
 * Transmite a posição GPS e telemetria atualizada para o círculo
 */
export function broadcastLocation(user = null) {
  if (!mqttClient || !isConnected) return;
  const dataToSend = user || getCleanCurrentUser();
  const payload = {
    type: 'LOCATION',
    user: {
      ...dataToSend,
      updatedAt: Date.now(),
    },
    ts: Date.now(),
  };
  try {
    mqttClient.publish(`${currentCircleTopic}/events`, JSON.stringify(payload));
  } catch (e) {
    console.warn('[Realtime Send Error]', e);
  }
}

/**
 * Transmite sinal de emergência SOS
 */
export function broadcastSOS(sosData) {
  if (!mqttClient || !isConnected) return;
  const payload = {
    type: 'SOS',
    user: getCleanCurrentUser(),
    data: sosData,
    ts: Date.now(),
  };
  try {
    mqttClient.publish(`${currentCircleTopic}/events`, JSON.stringify(payload));
  } catch (e) {
    console.warn('[Realtime Send Error]', e);
  }
}
