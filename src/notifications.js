// GeoPulse - Gerenciador de Notificações Push Nativas (APNs / FCM / Web Push)

// Chave pública VAPID padrão para testes locais/staging (Web Push W3C)
export const DEFAULT_VAPID_PUBLIC_KEY =
  'BCz5e8OqYf0Fm5zV4U8v1V0m5P0Xl3P7r6k0Y1p4K9l6O8a2I7m4Q3x9R5t8Y2u1I0o3P5a7S9d2F4g6H8j0K2l4';

/**
 * Converte chave pública VAPID base64 URL safe para Uint8Array
 */
export function urlBase64ToUint8Array(base64String) {
  try {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  } catch (err) {
    console.warn('[Push] Erro ao converter VAPID key:', err);
    return null;
  }
}

/**
 * Detecta se o navegador e o ambiente suportam Notificações Push
 */
export function isPushSupported() {
  return (
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

/**
 * Detecta se o aparelho é iPhone / iPad (iOS)
 */
export function isIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Detecta se o PWA está rodando em modo Standalone (Adicionado à Tela de Início)
 */
export function isStandalone() {
  return (
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

/**
 * Retorna o status atual da permissão de notificações
 */
export function getPermissionStatus() {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

/**
 * Recupera ou registra uma nova subscrição Push com o Service Worker
 */
export async function getOrRegisterSubscription(publicKey = DEFAULT_VAPID_PUBLIC_KEY) {
  if (!isPushSupported()) return null;

  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription && publicKey) {
      const convertedKey = urlBase64ToUint8Array(publicKey);
      if (convertedKey) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: convertedKey,
        });
      }
    }

    if (subscription) {
      localStorage.setItem('geopulse_push_sub', JSON.stringify(subscription));
      return subscription;
    }
  } catch (err) {
    console.warn('[Push] Falha ao obter subscrição do PushManager:', err);
  }

  // Se não foi possível gerar via VAPID ou deu erro de chave pública, verifica se há no storage
  const cached = localStorage.getItem('geopulse_push_sub');
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {}
  }
  return null;
}

/**
 * Solicita permissão ao usuário e registra a inscrição Push
 */
export async function requestPushPermission(publicKey = DEFAULT_VAPID_PUBLIC_KEY) {
  if (!isPushSupported()) {
    throw new Error('Notificações não são suportadas neste navegador.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { permission, subscription: null };
  }

  const subscription = await getOrRegisterSubscription(publicKey);
  return { permission, subscription };
}

/**
 * Dispara uma notificação nativa de teste (idêntica ao print do usuário)
 * @param {Object} options
 * @param {number} options.delaySeconds - Tempo em segundos antes do disparo (ideal para testar tela de bloqueio)
 */
export async function triggerTestPushNotification({
  delaySeconds = 0,
  title = 'Teste do backend até os aparelhos...',
  body = 'B6\nEnviado pelo backend de staging via APNs/FCM. Este é um teste de recebimento.',
  tag = 'geopulse-staging-test',
} = {}) {
  const currentPerm = getPermissionStatus();
  if (currentPerm !== 'granted') {
    const result = await requestPushPermission();
    if (result.permission !== 'granted') {
      throw new Error('Permissão de notificação não concedida no dispositivo.');
    }
  }

  const registration = await navigator.serviceWorker.ready;
  const notifOptions = {
    body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag,
    vibrate: [200, 100, 200, 100, 200],
    data: { url: '/', timestamp: Date.now() },
    requireInteraction: false,
  };

  if (delaySeconds > 0) {
    // Envia mensagem para o Service Worker disparar em segundo plano
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SCHEDULE_NOTIFICATION',
        title,
        options: notifOptions,
        delayMs: delaySeconds * 1000,
      });
    }

    // Fallback via timer no cliente caso a aba permaneça aberta
    setTimeout(() => {
      registration.showNotification(title, notifOptions).catch(() => {});
    }, delaySeconds * 1000);

    return { scheduled: true, delaySeconds };
  } else {
    // Disparo imediato
    await registration.showNotification(title, notifOptions);
    return { scheduled: false };
  }
}

/**
 * Dispara notificação push de Alerta SOS
 */
export async function notifySOSAlert(authorName = 'Membro') {
  const prefs = getNotificationPreferences();
  if (!prefs.sos || getPermissionStatus() !== 'granted') return;

  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification('🚨 ALERTA SOS EM ANDAMENTO', {
      body: `${authorName} acionou alerta de emergência no círculo tático!`,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'geopulse-sos-' + Date.now(),
      vibrate: [300, 100, 300, 100, 300],
      data: { url: '/' },
    });
  } catch (err) {
    console.warn('[Push] Erro ao enviar notificação de SOS:', err);
  }
}

/**
 * Dispara notificação push de Cerca Virtual violada
 */
export async function notifyGeofenceEvent(memberName, action, fenceName) {
  const prefs = getNotificationPreferences();
  if (!prefs.fence || getPermissionStatus() !== 'granted') return;

  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification('📍 Cerca Virtual Monitorada', {
      body: `${memberName} ${action} ${fenceName}.`,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'geopulse-fence-' + Date.now(),
      vibrate: [150, 80, 150],
      data: { url: '/' },
    });
  } catch (err) {
    console.warn('[Push] Erro ao enviar notificação de geofence:', err);
  }
}

/**
 * Preferências do Usuário no LocalStorage
 */
export function getNotificationPreferences() {
  try {
    const saved = localStorage.getItem('geopulse_notif_prefs');
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return { sos: true, fence: true };
}

export function saveNotificationPreferences(prefs) {
  localStorage.setItem('geopulse_notif_prefs', JSON.stringify(prefs));
}
