// GeoPulse - Webhook de Integração com Traccar Client / OwnTracks / GPS 24h em Segundo Plano
// Permite que iPhones e celulares com Traccar Client instalado transmitam localização com a tela apagada
import crypto from 'node:crypto';
import mqtt from 'mqtt';

// Cache em memória de últimos pings por chave circle:user
const recentPings = new Map();

function bufferToBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

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
  // Habilita CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Agrega parâmetros vindos de query string (GET/POST) ou body (POST JSON / URL-encoded)
  const query = req.query || {};
  let body = req.body || {};
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      // urlencoded fallback
      const searchParams = new URLSearchParams(body);
      body = Object.fromEntries(searchParams.entries());
    }
  }

  // Resolução do ID do Círculo e do Usuário
  // Suporta:
  // 1. ?circle=FAMILIA-1234&user=user_xyz
  // 2. id / deviceid no formato "FAMILIA-1234:user_xyz" ou "FAMILIA-1234__user_xyz"
  // 3. Fallback: id simples
  let rawCircle = query.circle || body.circle || '';
  let rawUser = query.user || body.user || query.id || body.id || query.deviceid || body.deviceid || '';

  if (rawUser && (!rawCircle || rawCircle === '')) {
    if (rawUser.includes(':')) {
      const parts = rawUser.split(':');
      rawCircle = parts[0];
      rawUser = parts.slice(1).join(':');
    } else if (rawUser.includes('__')) {
      const parts = rawUser.split('__');
      rawCircle = parts[0];
      rawUser = parts.slice(1).join('__');
    }
  }

  const circleId = (rawCircle || 'FAMILIA-1').trim();
  const userId = (rawUser || 'iphone_traccar').trim();
  const cacheKey = `${circleId}:${userId}`;

  // Se for apenas uma verificação de status (GET sem coordenadas)
  const rawLat = query.lat ?? body.lat;
  const rawLon = query.lon ?? query.lng ?? body.lon ?? body.lng;

  if (rawLat === undefined || rawLon === undefined) {
    const last = recentPings.get(cacheKey);
    return res.status(200).json({
      status: 'waiting_for_signal',
      message: 'GeoPulse Traccar Webhook Ativo. Envie coordenadas via lat e lon.',
      circle: circleId,
      user: userId,
      lastPing: last || null,
      serverTime: Date.now(),
    });
  }

  const lat = parseFloat(rawLat);
  const lng = parseFloat(rawLon);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'Coordenadas lat e lon inválidas.' });
  }

  // Velocidade: Traccar Client envia em nós (knots). 1 knot = 1.852 km/h
  let speedKmH = 0;
  if (query.speed !== undefined || body.speed !== undefined) {
    const s = parseFloat(query.speed ?? body.speed);
    if (!Number.isNaN(s)) speedKmH = s * 1.852;
  } else if (body.vel !== undefined) {
    const v = parseFloat(body.vel);
    if (!Number.isNaN(v)) speedKmH = v;
  }

  // Bateria: 0-100
  let battery = 95;
  const rawBatt = query.batt ?? body.batt ?? body.battery;
  if (rawBatt !== undefined) {
    const b = parseFloat(rawBatt);
    if (!Number.isNaN(b)) battery = Math.max(0, Math.min(100, Math.round(b)));
  }

  // Precisão e Direção
  const accuracy = parseFloat(query.accuracy ?? query.hdop ?? body.acc ?? 10) || 10;
  const heading = parseFloat(query.bearing ?? query.heading ?? body.cog ?? 0) || 0;
  const isCharging = query.charge === 'true' || body.charge === true;

  // Timestamp
  let timestamp = Date.now();
  const rawTime = query.timestamp || query.time || body.tst;
  if (rawTime) {
    const tNum = Number(rawTime);
    if (!Number.isNaN(tNum)) {
      timestamp = tNum < 10000000000 ? tNum * 1000 : tNum;
    } else {
      const d = new Date(rawTime).getTime();
      if (!Number.isNaN(d)) timestamp = d;
    }
  }

  // Atualiza cache em memória
  const pingData = {
    circleId,
    userId,
    lat,
    lng,
    speed: Math.round(speedKmH),
    heading: Math.round(heading),
    accuracy,
    battery,
    charging: isCharging,
    updatedAt: timestamp,
    receivedAt: Date.now(),
  };
  recentPings.set(cacheKey, pingData);

  // Monta objeto de payload de membro compatível com o GeoPulse
  const activity = speedKmH > 22 ? '🚗 Em trânsito' : (speedKmH > 3 ? '🚶 Caminhando' : '📍 Parado');

  const locationPayload = {
    type: 'LOCATION',
    user: {
      id: userId,
      name: body.name || query.name || 'Você (iPhone)',
      lat,
      lng,
      accuracy,
      speed: Math.round(speedKmH),
      heading: Math.round(heading),
      battery,
      charging: isCharging,
      activity,
      updatedAt: timestamp,
      isOnline: true,
      source: 'traccar_background',
    },
    senderId: `traccar_${userId}`,
    ts: timestamp,
  };

  // Cifra com AES-256 GCM e publica no MQTT HiveMQ
  const topicPrefix = deriveMqttTopic(circleId);
  const encryptedEnvelope = encryptPayload(locationPayload, circleId);
  const serialized = JSON.stringify(encryptedEnvelope);

  try {
    await new Promise((resolve) => {
      const client = mqtt.connect('mqtt://broker.hivemq.com:1883', {
        clientId: `gp_srv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        connectTimeout: 4000,
      });

      const finish = () => {
        try { client.end(); } catch (e) {}
        resolve();
      };

      const timer = setTimeout(finish, 4000);

      client.on('connect', () => {
        // 1. Mensagem retida por membro para entrega imediata a qualquer celular que abrir o PWA
        client.publish(`${topicPrefix}/members/${userId}/location`, serialized, { qos: 1, retain: true }, () => {
          // 2. Stream de eventos em tempo real
          client.publish(`${topicPrefix}/events`, serialized, { qos: 0, retain: false }, () => {
            clearTimeout(timer);
            finish();
          });
        });
      });

      client.on('error', (err) => {
        console.warn('[Traccar Webhook] Erro MQTT:', err?.message);
        clearTimeout(timer);
        finish();
      });
    });
  } catch (err) {
    console.warn('[Traccar Webhook] Exceção ao publicar:', err);
  }

  // Responde com sucesso (Traccar Client espera HTTP 200)
  return res.status(200).json({
    status: 'ok',
    message: 'Localização atualizada com sucesso no GeoPulse!',
    circle: circleId,
    user: userId,
    lat,
    lng,
    updatedAt: timestamp,
  });
}
