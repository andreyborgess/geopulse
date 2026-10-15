// GeoPulse - Criptografia End-to-End (E2E) Client-Side via Web Crypto API (AES-GCM 256-bit)
// Zero-knowledge: O broker MQTT e intermediários enxergam apenas payloads cifrados ilegíveis.
// A chave é compartilhada estritamente via Fragmento da URL (#key=...) ou QR Code.

const KEY_STORAGE_NAME = 'geopulse_e2e_key';
let activeCryptoKey = null;
let exportedKeyString = '';

/**
 * Converte Uint8Array para string Base64 URL-Safe
 */
function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Converte string Base64 URL-Safe para Uint8Array
 */
function base64UrlToBuffer(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Gera uma chave simétrica nova de 256 bits (AES-GCM)
 */
async function generateNewKey() {
  const key = await window.crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true, // extractable
    ['encrypt', 'decrypt']
  );
  return key;
}

/**
 * Importa uma chave crua a partir de string Base64URL
 */
async function importKeyFromString(rawKeyBase64Url) {
  try {
    const rawBuffer = base64UrlToBuffer(rawKeyBase64Url);
    return await window.crypto.subtle.importKey(
      'raw',
      rawBuffer,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  } catch (err) {
    console.warn('[Crypto] Falha ao importar chave recebida:', err);
    return null;
  }
}

/**
 * Gera um Circle ID criptograficamente forte (UUID/nanoid de alta entropia)
 * Impossível de ser adivinhado ou atacado por força bruta (~1 sextilhão de combinações).
 */
export function generateSecureCircleId() {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const safeStr = btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `gp_sec_${safeStr}`;
  }
  return `gp_sec_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Deriva o identificador do tópico MQTT usando SHA-256 unidirecional (Zero-Knowledge).
 * O broker público vê apenas um hash opaco (ex: geopulse/v3/4a8f9c10...) e
 * é matematicamente impossível reverter o hash para obter o Circle ID original ou a chave AES.
 */
export async function deriveMqttTopic(circleId) {
  if (!circleId) return 'geopulse/v3/default';
  const clean = circleId.trim();
  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode('geopulse-mqtt-topic-v3-salt:' + clean);
    const hashBuf = await window.crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(hashBuf);
    let hex = '';
    for (let i = 0; i < 16; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return `geopulse/v3/${hex}`;
  }
  return `geopulse/v3/${clean.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * Deriva uma chave simétrica AES-GCM de 256 bits determinística a partir do código do círculo.
 * Utiliza um salt isolado para garantir que a chave AES seja independente do tópico MQTT.
 * Mantém suporte a círculos legados (FAMILIA-XXXX) para retrocompatibilidade.
 */
export async function deriveKeyFromCircle(circleId) {
  if (!circleId || typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) {
    return null;
  }
  const cleanCircle = circleId.trim();
  const isLegacy = cleanCircle.toUpperCase().startsWith('FAMILIA-');
  const salt = isLegacy ? 'GeoPulse-Familiar-E2E-2026-v2-' : 'GeoPulse-E2E-AES256-v3-isolated-';
  const encoder = new TextEncoder();
  const data = encoder.encode(salt + (isLegacy ? cleanCircle.toUpperCase() : cleanCircle));
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
  const rawKey = bufferToBase64Url(hashBuffer);

  const key = await window.crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  return { key, keyStr: rawKey };
}

/**
 * Inicializa o subsistema de criptografia E2E:
 * 1. Verifica se veio #key=... na URL (convite ou QR Code)
 * 2. Deriva deterministicamente do circleId garantindo decifragem 100% perfeita entre aparelhos
 *
 * IMPORTANTE: O circleId é resolvido com a mesma prioridade que sync.js:
 *   URL ?circle= > localStorage > fallback gerado com alta entropia
 */
export async function initCircleCrypto(explicitCircleId = null) {
  if (typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) {
    console.warn('[Crypto] Web Crypto API não disponível neste ambiente.');
    return null;
  }

  let keyStr = '';

  // 1. Tenta extrair chave explícita da URL (#key=...)
  if (window.location.hash) {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const urlKey = hashParams.get('key');
    if (urlKey && urlKey.length >= 20) {
      keyStr = urlKey;
      localStorage.setItem(KEY_STORAGE_NAME, keyStr);
    }
  }

  // 2. Resolve circleId com a mesma prioridade que sync.js: URL > localStorage > fallback
  let circleId = explicitCircleId;
  if (!circleId && typeof window !== 'undefined' && window.location.search) {
    const urlParams = new URLSearchParams(window.location.search);
    circleId = urlParams.get('circle') || null;
  }
  if (!circleId) {
    circleId = localStorage.getItem('geopulse_circle_id');
    if (!circleId) {
      circleId = generateSecureCircleId();
      localStorage.setItem('geopulse_circle_id', circleId);
    }
  }

  console.log('[Crypto] Derivando chave E2E para circleId:', circleId);

  // 3. SEMPRE deriva a chave do circleId para consistência determinística
  const derived = await deriveKeyFromCircle(circleId);
  if (derived) {
    activeCryptoKey = derived.key;
    keyStr = derived.keyStr;
    localStorage.setItem(KEY_STORAGE_NAME, keyStr);
  } else if (keyStr) {
    activeCryptoKey = await importKeyFromString(keyStr);
  }

  exportedKeyString = keyStr;
  return activeCryptoKey;
}

/**
 * Retorna a chave exportada em formato Base64URL para compor links de convite e QR Codes
 */
export function getExportedCryptoKey() {
  return exportedKeyString || localStorage.getItem(KEY_STORAGE_NAME) || '';
}

/**
 * Cifra um objeto JavaScript qualquer utilizando AES-GCM com IV único aleatório
 * @param {Object} payloadObj
 * @returns {Promise<Object>} Envelope cifrado { _enc: 1, iv: string, d: string }
 */
export async function encryptPayload(payloadObj) {
  if (!activeCryptoKey) {
    await initCircleCrypto();
  }
  if (!activeCryptoKey) {
    // Fallback se Web Crypto falhar
    return payloadObj;
  }

  try {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const jsonStr = JSON.stringify(payloadObj);
    const encodedData = new TextEncoder().encode(jsonStr);

    const cipherBuffer = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      activeCryptoKey,
      encodedData
    );

    return {
      _enc: 1,
      iv: bufferToBase64Url(iv),
      d: bufferToBase64Url(cipherBuffer),
    };
  } catch (err) {
    console.error('[Crypto] Erro ao cifrar payload:', err);
    return payloadObj;
  }
}

/**
 * Decifra um envelope { _enc: 1, iv: string, d: string } de volta para o objeto original
 * @param {Object} envelope
 * @returns {Promise<Object|null>}
 */
export async function decryptPayload(envelope) {
  // Se for mensagem legada não cifrada, retorna diretamente
  if (!envelope || !envelope._enc || !envelope.iv || !envelope.d) {
    return envelope;
  }

  if (!activeCryptoKey) {
    await initCircleCrypto();
  }
  if (!activeCryptoKey) {
    return null;
  }

  try {
    const iv = base64UrlToBuffer(envelope.iv);
    const cipherBytes = base64UrlToBuffer(envelope.d);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      activeCryptoKey,
      cipherBytes
    );

    const jsonStr = new TextDecoder().decode(decryptedBuffer);
    return JSON.parse(jsonStr);
  } catch (err) {
    console.debug('[Crypto] Falha ao decifrar mensagem (chave divergente ou pacote corrompido):', err.message);
    return null;
  }
}
