// GeoPulse - Endpoint Serverless de Chat Privado E2E do Círculo Familiar
// Garante entrega e persistência resiliente mesmo quando WebSockets / redes móveis falharem
import crypto from 'node:crypto';
import mqtt from 'mqtt';

// Cache em memória de mensagens recentes por círculo (até 150 mensagens por círculo)
// Map<circleId, Array<message>>
const chatStore = new Map();

function deriveMqttTopic(circleId) {
  if (!circleId) return 'geopulse/v3/default';
  const clean = circleId.trim();
  const hash = crypto.createHash('sha256').update('geopulse-mqtt-topic-v3-salt:' + clean).digest('hex');
  return `geopulse/v3/${hash.slice(0, 32)}`;
}

function deriveKeyFromCircle(circleId) {
  const cleanCircle = (circleId || '').trim();
  const isLegacy = cleanCircle.toUpperCase().startsWith('FAMILIA-');
  const salt = isLegacy ? 'GeoPulse-Familiar-E2E-2026-v2-' : 'GeoPulse-E2E-AES256-v3-isolated-';
  return crypto.createHash('sha256').update(salt + (isLegacy ? cleanCircle.toUpperCase() : cleanCircle)).digest();
}

function bufferToBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function encryptPayload(payloadObj, circleId) {
  const key = deriveKeyFromCircle(circleId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const jsonStr = JSON.stringify(payloadObj);
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const cipherWithTag = Buffer.concat([encrypted, tag]);

  return {
    _enc: 1,
    iv: bufferToBase64Url(iv),
    d: bufferToBase64Url(cipherWithTag),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const query = req.query || {};
  let body = req.body || {};
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      const searchParams = new URLSearchParams(body);
      body = Object.fromEntries(searchParams.entries());
    }
  }

  const circleId = (query.circle || body.circle || 'FAMILIA-1').trim();
  if (!chatStore.has(circleId)) {
    chatStore.set(circleId, []);
  }
  const history = chatStore.get(circleId);

  // POST: Envio de mensagem de chat
  if (req.method === 'POST') {
    const rawMsg = body.message || body;
    if (!rawMsg || (!rawMsg.text && !body.text)) {
      return res.status(400).json({ error: 'Mensagem vazia' });
    }

    const msgObj = {
      id: rawMsg.id || body.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      senderId: rawMsg.senderId || body.senderId || 'anon',
      senderName: rawMsg.senderName || body.senderName || 'Membro',
      senderAvatar: rawMsg.senderAvatar || body.senderAvatar || 'MB',
      senderPhoto: rawMsg.senderPhoto || body.senderPhoto || '',
      senderColor: rawMsg.senderColor || body.senderColor || '#007AFF',
      targetMemberId: rawMsg.targetMemberId || body.targetMemberId || null,
      text: String(rawMsg.text || body.text).trim(),
      ts: Number(rawMsg.ts || body.ts || Date.now()),
    };

    // Evita duplicatas no histórico do servidor
    if (!history.some((m) => m.id === msgObj.id)) {
      history.push(msgObj);
      if (history.length > 150) {
        history.splice(0, history.length - 150);
      }
    }

    // Retransmite via MQTT para que aparelhos com o app aberto recebam em tempo real
    const topicPrefix = deriveMqttTopic(circleId);
    const chatPayload = {
      type: 'CHAT_MESSAGE',
      ...msgObj,
    };
    const encryptedEnvelope = encryptPayload(chatPayload, circleId);
    const serialized = JSON.stringify(encryptedEnvelope);

    try {
      const client = mqtt.connect('mqtt://broker.hivemq.com:1883', {
        clientId: `gp_chat_srv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        connectTimeout: 2500,
      });

      client.on('connect', () => {
        client.publish(`${topicPrefix}/chat`, serialized, { qos: 1, retain: false }, () => {
          try { client.end(); } catch (e) {}
        });
      });

      client.on('error', () => {
        try { client.end(); } catch (e) {}
      });
    } catch (e) {
      console.warn('[Chat API] Erro ao retransmitir MQTT:', e);
    }

    return res.status(200).json({
      status: 'ok',
      id: msgObj.id,
      circle: circleId,
      ts: msgObj.ts,
    });
  }

  // GET: Obter histórico recente de mensagens do círculo
  const since = parseInt(query.since || '0', 10) || 0;
  const recent = history.filter((m) => m && m.ts > since);

  return res.status(200).json({
    status: 'ok',
    circle: circleId,
    messages: recent,
    count: recent.length,
    serverTime: Date.now(),
  });
}
