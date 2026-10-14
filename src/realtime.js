// GeoPulse - Módulo de Sincronização em Tempo Real de Alta Performance & Criptografia E2E
// Multi-Broker Fallback (HiveMQ -> EMQX -> Mosquitto), Fila Offline Resiliente & Criptografia AES-256
import mqtt from 'mqtt';
import { state, saveMembersToStorage, savePlacesToStorage, mergeRemoteMember, mergeRemotePlace } from './sync.js';
import { encryptPayload, decryptPayload } from './crypto.js';
import { enqueueMessage, flushOutbox, getPendingQueueCount } from './outbox.js';

let mqttClient = null;
let currentCircleTopic = '';
let wakeLockSentinel = null;
let heartbeatInterval = null;
let isConnected = false;
let currentBrokerIndex = 0;
let connectionFailures = 0;
let activeStatusCallback = null;

// Lista de brokers WebSocket seguros com SSL/TLS para redundância total
const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

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
    updatedAt: state.currentUser.updatedAt || Date.now(),
    version: state.currentUser.version || 1,
    sos: !!state.currentUser.sos,
  };
}

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
 * Publica mensagem cifrada com E2E e fallback para fila offline se desconectado
 */
async function publishEncrypted(subTopic, payloadObj, qos = 0) {
  const fullTopic = `${currentCircleTopic}/${subTopic}`;

  // Se estiver desconectado, enfileira na outbox offline
  if (!mqttClient || !isConnected) {
    enqueueMessage(fullTopic, payloadObj, qos);
    if (activeStatusCallback) {
      activeStatusCallback({
        status: 'reconnecting',
        broker: BROKERS[currentBrokerIndex],
        pendingCount: getPendingQueueCount(),
      });
    }
    return false;
  }

  try {
    const encryptedEnvelope = await encryptPayload(payloadObj);
    const serialized = JSON.stringify(encryptedEnvelope);

    return new Promise((resolve) => {
      mqttClient.publish(fullTopic, serialized, { qos }, (err) => {
        if (err) {
          console.warn('[Realtime Publish Err]', err);
          enqueueMessage(fullTopic, payloadObj, qos);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  } catch (err) {
    console.warn('[Realtime Encrypt/Publish Err]', err);
    enqueueMessage(fullTopic, payloadObj, qos);
    return false;
  }
}

/**
 * Inicializa a sincronização em tempo real entre todos os aparelhos do círculo
 */
export function initRealtimeNetwork({
  onMemberJoined,
  onMemberUpdated,
  onMemberDeleted,
  onLocationReceived,
  onPlaceUpdated,
  onGeofenceAlertReceived,
  onSOSReceived,
  onRingReceived,
  onStatusChanged,
}) {
  activeStatusCallback = onStatusChanged;
  const circleIdSafe = (state.circleId || 'FAMILIA-01').replace(/[^a-zA-Z0-9_-]/g, '');
  currentCircleTopic = `geopulse/v2/${circleIdSafe}`;

  const clientId = `gp_${state.currentUser.id}_${Math.random().toString(36).slice(2, 7)}`;

  const connectToCurrentBroker = () => {
    const brokerUrl = BROKERS[currentBrokerIndex];
    console.log(`[Realtime] Conectando ao broker ${brokerUrl} (${currentBrokerIndex + 1}/${BROKERS.length})...`);

    if (onStatusChanged) {
      onStatusChanged({
        status: 'connecting',
        broker: brokerUrl,
        pendingCount: getPendingQueueCount(),
      });
    }

    try {
      if (mqttClient) {
        try {
          mqttClient.end(true);
        } catch (e) {}
      }

      const client = mqtt.connect(brokerUrl, {
        clientId,
        clean: true,
        connectTimeout: 7000,
        reconnectPeriod: 3000,
        keepalive: 25,
      });

      client.on('connect', () => {
        isConnected = true;
        connectionFailures = 0;
        console.log(`[Realtime] Conectado com sucesso via ${brokerUrl}!`);

        if (onStatusChanged) {
          onStatusChanged({
            status: 'online',
            broker: brokerUrl,
            pendingCount: getPendingQueueCount(),
          });
        }

        // Inscreve-se nos tópicos de eventos do círculo
        client.subscribe(`${currentCircleTopic}/#`, { qos: 0 }, (err) => {
          if (!err) {
            console.log(`[Realtime] Inscrito no tópico do círculo: ${currentCircleTopic}/#`);

            // Anuncia a entrada do aparelho no círculo
            broadcastJoin();

            // Descarrega mensagens pendentes acumuladas enquanto estava offline
            flushOutbox(async (topic, payload, qos) => {
              const encrypted = await encryptPayload(payload);
              return new Promise((res) => {
                client.publish(topic, JSON.stringify(encrypted), { qos }, (publishErr) => {
                  res(!publishErr);
                });
              });
            });

            // Heartbeat periódico leve a cada 15 segundos
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
              if (isConnected && mqttClient) {
                broadcastPresence();
              }
            }, 15000);
          }
        });
      });

      client.on('message', async (topic, rawMessage) => {
        try {
          const rawEnvelope = JSON.parse(rawMessage.toString());
          // Decifra E2E utilizando Web Crypto API
          const payload = await decryptPayload(rawEnvelope);
          if (!payload || !payload.type) return;

          const remoteUser = payload.user;

          // Ignora mensagens originadas do próprio aparelho
          if (remoteUser && remoteUser.id === state.currentUser.id) return;
          if (payload.senderId && payload.senderId === state.currentUser.id) return;

          const now = Date.now();

          if (payload.type === 'JOIN' && remoteUser) {
            const isKnownMember = state.members.has(remoteUser.id);
            const changed = mergeRemoteMember(remoteUser);

            const isFirstTimeInvite = !!payload.isNewInvite && !isKnownMember;
            if (onMemberJoined) onMemberJoined(remoteUser, isFirstTimeInvite);
            if (changed && onMemberUpdated) onMemberUpdated(remoteUser);

            // Sincroniza lugares e membros que o novo aparelho trouxe com LWW
            if (payload.places && Array.isArray(payload.places)) {
              let placesChanged = false;
              payload.places.forEach((p) => {
                if (mergeRemotePlace(p)) placesChanged = true;
              });
              if (placesChanged && onPlaceUpdated) onPlaceUpdated();
            }

            // Responde imediatamente com presença para o novo celular registrar
            setTimeout(() => {
              broadcastPresence();
            }, 300);

          } else if (payload.type === 'PRESENCE' && remoteUser) {
            const changed = mergeRemoteMember(remoteUser);
            if (changed && onMemberUpdated) onMemberUpdated(remoteUser);

            if (payload.places && Array.isArray(payload.places)) {
              let placesChanged = false;
              payload.places.forEach((p) => {
                if (mergeRemotePlace(p)) placesChanged = true;
              });
              if (placesChanged && onPlaceUpdated) onPlaceUpdated();
            }

          } else if (payload.type === 'LOCATION' && remoteUser) {
            const changed = mergeRemoteMember(remoteUser);
            if (onLocationReceived) onLocationReceived(remoteUser);
            if (changed && onMemberUpdated) onMemberUpdated(remoteUser);

          } else if (payload.type === 'PLACE_SAVED' && payload.place) {
            console.log('[Realtime] Lugar recebido com E2E:', payload.place.name);
            const changed = mergeRemotePlace(payload.place);
            if (changed && onPlaceUpdated) onPlaceUpdated();

          } else if (payload.type === 'PLACE_DELETED' && payload.placeId) {
            console.log('[Realtime] Remoção de lugar recebida:', payload.placeId);
            state.geofences = state.geofences.filter((p) => p.id !== payload.placeId);
            savePlacesToStorage();
            if (onPlaceUpdated) onPlaceUpdated();

          } else if (payload.type === 'GEOFENCE_ALERT' && payload.event) {
            const ev = payload.event;
            if (ev.memberId !== state.currentUser.id && payload.senderId !== state.currentUser.id) {
              if (onGeofenceAlertReceived) onGeofenceAlertReceived(ev);
            }

          } else if (payload.type === 'MEMBER_DELETED') {
            const memberId = payload.memberId;
            if (memberId && state.members.has(memberId)) {
              state.members.delete(memberId);
              saveMembersToStorage();
              if (onMemberDeleted) onMemberDeleted(memberId);
            }

          } else if (payload.type === 'SOS') {
            console.warn('[Realtime] Alerta SOS decifrado:', remoteUser?.name || payload.data?.author);
            if (onSOSReceived) onSOSReceived(payload);

          } else if (payload.type === 'RING_DEVICE') {
            console.log('[Realtime] Alerta sonoro recebido:', payload);
            if (onRingReceived) onRingReceived(payload);
          }
        } catch (err) {
          console.warn('[Realtime] Falha ao processar mensagem MQTT:', err);
        }
      });

      client.on('close', () => {
        isConnected = false;
        if (onStatusChanged) {
          onStatusChanged({
            status: 'offline',
            broker: brokerUrl,
            pendingCount: getPendingQueueCount(),
          });
        }
      });

      client.on('error', (err) => {
        connectionFailures++;
        console.warn(`[Realtime Broker Error] ${brokerUrl}:`, err?.message || err);

        // Se falhar 3 vezes consecutivas, migra para o próximo broker na lista de fallback
        if (connectionFailures >= 3) {
          connectionFailures = 0;
          currentBrokerIndex = (currentBrokerIndex + 1) % BROKERS.length;
          console.log(`[Realtime] Alternando para broker redundante: ${BROKERS[currentBrokerIndex]}`);
          setTimeout(connectToCurrentBroker, 1500);
        }
      });

      return client;
    } catch (e) {
      console.error('[Realtime Init Error]', e);
      return null;
    }
  };

  mqttClient = connectToCurrentBroker();
  enableScreenWakeLock();

  return {
    broadcastLocation: (user) => broadcastLocation(user),
    broadcastSOS: (sosData) => broadcastSOS(sosData),
    broadcastRingDevice: (targetId) => broadcastRingDevice(targetId),
    broadcastMemberDeleted: (memberId) => broadcastMemberDeleted(memberId),
    broadcastPlaceSaved: (place) => broadcastPlaceSaved(place),
    broadcastPlaceDeleted: (placeId) => broadcastPlaceDeleted(placeId),
    broadcastGeofenceAlert: (eventData) => broadcastGeofenceAlert(eventData),
    broadcastJoin: () => broadcastJoin(),
    broadcastPresence: () => broadcastPresence(),
    isConnected: () => isConnected,
  };
}

/**
 * Publica anúncio de entrada no círculo transmitindo lugares salvos e membros
 */
export function broadcastJoin() {
  let isNewInvite = false;
  try {
    isNewInvite = sessionStorage.getItem('geopulse_is_new_join') === 'true';
  } catch (e) {}

  const payload = {
    type: 'JOIN',
    user: getCleanCurrentUser(),
    places: state.geofences,
    isNewInvite,
    ts: Date.now(),
  };

  publishEncrypted('events', payload, 0);
}

/**
 * Publica presença regular para todos os aparelhos saberem que este celular está ativo
 */
export function broadcastPresence() {
  const payload = {
    type: 'PRESENCE',
    user: getCleanCurrentUser(),
    places: state.geofences,
    ts: Date.now(),
  };

  publishEncrypted('events', payload, 0);
}

/**
 * Transmite um lugar cadastrado para todos os outros aparelhos do círculo
 */
export function broadcastPlaceSaved(place) {
  const payload = {
    type: 'PLACE_SAVED',
    place,
    circleId: state.circleId,
    senderId: state.currentUser.id,
    ts: Date.now(),
  };

  publishEncrypted('events', payload, 1);
  console.log('[Realtime] Lugar salvo transmitido com E2E:', place.name);
}

/**
 * Transmite a exclusão de um lugar para todos os outros celulares
 */
export function broadcastPlaceDeleted(placeId) {
  const payload = {
    type: 'PLACE_DELETED',
    placeId,
    circleId: state.circleId,
    senderId: state.currentUser.id,
    ts: Date.now(),
  };

  publishEncrypted('events', payload, 1);
  console.log('[Realtime] Remoção de lugar transmitida:', placeId);
}

/**
 * Transmite a posição GPS e telemetria atualizada para o círculo
 */
export function broadcastLocation(user = null) {
  const dataToSend = user || getCleanCurrentUser();
  const payload = {
    type: 'LOCATION',
    user: {
      ...dataToSend,
      updatedAt: Date.now(),
    },
    ts: Date.now(),
  };

  publishEncrypted('events', payload, 0);
}

/**
 * Transmite sinal de emergência SOS
 */
export function broadcastSOS(sosData) {
  const payload = {
    type: 'SOS',
    user: getCleanCurrentUser(),
    data: sosData,
    ts: Date.now(),
  };

  publishEncrypted('events', payload, 1);
}

/**
 * Transmite sinal para tocar som de alta intensidade no aparelho de um membro (Find My)
 */
export function broadcastRingDevice(targetId) {
  const payload = {
    type: 'RING_DEVICE',
    targetId,
    senderName: state.currentUser.name,
    senderId: state.currentUser.id,
    user: getCleanCurrentUser(),
    ts: Date.now(),
  };

  publishEncrypted('events', payload, 1);
}

/**
 * Transmite a remoção de um membro para que todos os celulares do círculo sincronizem a exclusão
 */
export function broadcastMemberDeleted(memberId) {
  const payload = {
    type: 'MEMBER_DELETED',
    memberId,
    senderId: state.currentUser.id,
    ts: Date.now(),
  };

  publishEncrypted('events', payload, 1);
}

/**
 * Transmite alerta de chegada/saída de lugar para todos os outros celulares da família
 */
export function broadcastGeofenceAlert(eventData) {
  const payload = {
    type: 'GEOFENCE_ALERT',
    event: eventData,
    circleId: state.circleId,
    senderId: state.currentUser.id,
    ts: Date.now(),
  };

  publishEncrypted('events', payload, 1);
  console.log('[Realtime] Alerta de lugar transmitido para o círculo:', eventData.memberName, eventData.type, eventData.fenceName);
}
