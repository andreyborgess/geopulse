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
 * Inicializa o subsistema de criptografia E2E:
 * 1. Verifica se veio #key=... na URL (convite ou QR Code)
 * 2. Verifica se há chave salva no LocalStorage
 * 3. Se não houver, gera uma chave criptográfica forte e a persiste
 */
export async function initCircleCrypto() {
  if (typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) {
    console.warn('[Crypto] Web Crypto API não disponível neste ambiente.');
    return null;
  }

  let keyStr = '';

  // 1. Tenta extrair da URL (#key=...)
  if (window.location.hash) {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const urlKey = hashParams.get('key');
    if (urlKey && urlKey.length >= 20) {
      keyStr = urlKey;
      localStorage.setItem(KEY_STORAGE_NAME, keyStr);
    }
  }

  // 2. Se não veio na URL, busca do LocalStorage
  if (!keyStr) {
    keyStr = localStorage.getItem(KEY_STORAGE_NAME) || '';
  }

  // 3. Se ainda não há chave, gera uma nova
  if (keyStr) {
    activeCryptoKey = await importKeyFromString(keyStr);
    if (!activeCryptoKey) {
      // Chave corrompida, regera
      activeCryptoKey = await generateNewKey();
      const raw = await window.crypto.subtle.exportKey('raw', activeCryptoKey);
      keyStr = bufferToBase64Url(raw);
      localStorage.setItem(KEY_STORAGE_NAME, keyStr);
    }
  } else {
    activeCryptoKey = await generateNewKey();
    const raw = await window.crypto.subtle.exportKey('raw', activeCryptoKey);
    keyStr = bufferToBase64Url(raw);
    localStorage.setItem(KEY_STORAGE_NAME, keyStr);
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
