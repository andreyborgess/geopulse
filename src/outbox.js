// GeoPulse - Fila Offline Resiliente (Outbox Queue)
// Garante que alertas de emergência, lugares e posições não sejam perdidos em caso de queda de 4G/Wi-Fi

const OUTBOX_STORAGE_KEY = 'geopulse_offline_outbox';
const MAX_QUEUE_SIZE = 40;

let memoryQueue = [];

// Inicializa fila a partir do LocalStorage
try {
  const saved = localStorage.getItem(OUTBOX_STORAGE_KEY);
  if (saved) {
    const parsed = JSON.parse(saved);
    if (Array.isArray(parsed)) {
      memoryQueue = parsed;
    }
  }
} catch (e) {
  memoryQueue = [];
}

function saveQueueToStorage() {
  try {
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(memoryQueue));
  } catch (e) {}
}

/**
 * Adiciona uma mensagem à fila offline com deduplicação inteligente
 * Se for atualização contínua de LOCATION, substitui pela mais recente
 * Se for SOS, PLACE ou RING, preserva integralmente
 */
export function enqueueMessage(topic, payload, qos = 0) {
  const item = {
    id: `outbox_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    topic,
    payload,
    qos,
    createdAt: Date.now(),
  };

  // Desduplicação de LOCATION: se já existe um LOCATION pendente na fila, substitui
  if (payload && payload.type === 'LOCATION') {
    const existingIdx = memoryQueue.findIndex((q) => q.payload && q.payload.type === 'LOCATION');
    if (existingIdx !== -1) {
      memoryQueue[existingIdx] = item;
      saveQueueToStorage();
      return;
    }
  }

  memoryQueue.push(item);

  // Mantém fila dentro do limite máximo
  if (memoryQueue.length > MAX_QUEUE_SIZE) {
    // Descarta o mais antigo desde que não seja SOS
    const nonSosIdx = memoryQueue.findIndex((q) => q.payload?.type !== 'SOS');
    if (nonSosIdx !== -1) {
      memoryQueue.splice(nonSosIdx, 1);
    } else {
      memoryQueue.shift();
    }
  }

  saveQueueToStorage();
}

/**
 * Descarrega a fila enviando cada item via transportador ativo (MQTT / WebRTC)
 * @param {Function} sendFn - async (topic, payload, qos) => boolean
 */
export async function flushOutbox(sendFn) {
  if (memoryQueue.length === 0) return 0;

  console.log(`[Outbox] Descarregando ${memoryQueue.length} mensagem(ns) pendente(s)...`);
  const itemsToSend = [...memoryQueue];
  let sentCount = 0;

  for (let i = 0; i < itemsToSend.length; i++) {
    const item = itemsToSend[i];
    try {
      const ok = await sendFn(item.topic, item.payload, item.qos);
      if (ok) {
        sentCount++;
        // Remove da fila
        const idx = memoryQueue.findIndex((q) => q.id === item.id);
        if (idx !== -1) {
          memoryQueue.splice(idx, 1);
          saveQueueToStorage();
        }
      } else {
        // Se falhou o envio, interrompe o flush para tentar depois
        break;
      }
    } catch (err) {
      console.warn('[Outbox] Falha ao enviar item da fila:', err);
      break;
    }
  }

  saveQueueToStorage();
  return sentCount;
}

export function getPendingQueueCount() {
  return memoryQueue.length;
}

export function clearOutbox() {
  memoryQueue = [];
  saveQueueToStorage();
}
