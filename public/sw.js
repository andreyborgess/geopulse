// GeoPulse 2.0 - Service Worker v9 (Offline PWA, Map Tile Caching & Web Push APNs/FCM)
const CACHE_NAME = 'geopulse-app-v9';
const TILE_CACHE_NAME = 'geopulse-tiles-v5';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/favicon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Cache addAll parcial:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          // Limpa caches antigos (incluindo v1..v8)
          if (key !== CACHE_NAME && key !== TILE_CACHE_NAME) {
            console.log('[SW] Purgando cache antigo:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ignora requisições que não sejam HTTP/HTTPS (ex: chrome-extension, peerjs, webrtc)
  if (!event.request.url.startsWith('http')) {
    return;
  }

  // 1. Tiles de Mapa (CartoDB Dark Matter, OpenStreetMap, Esri ArcGIS - 100% Livres de API Key)
  const isMapTile =
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('cartocdn.com') ||
    url.pathname.includes('/tile/') ||
    url.pathname.includes('/tiles/') ||
    url.pathname.includes('/rastertiles/');

  if (isMapTile) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILE_CACHE_NAME);
        
        // Tenta rede primeiro para manter o mapa atualizado
        try {
          // Imagens Leaflet usam mode no-cors. Nunca forçar mode: 'cors'.
          const networkResponse = await fetch(event.request);
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          // Se estiver offline ou falhar na rede, tenta o cache local
          const cachedResponse = await cache.match(event.request);
          if (cachedResponse) {
            return cachedResponse;
          }
          // Se não tiver no cache e estiver offline, retorna 404 limpo
          return new Response('', { status: 404, statusText: 'Tile Not In Cache' });
        }
      })()
    );
    return;
  }

  // 2. Navegação (HTML principal para PWA offline)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          const cache = await caches.open(CACHE_NAME);
          const cached = (await cache.match('/index.html')) || (await cache.match('/'));
          if (cached) return cached;
          throw err;
        }
      })()
    );
    return;
  }

  // 3. Recursos Estáticos da Aplicação (CSS, JS, Fontes, SVGs)
  event.respondWith(
    (async () => {
      // Para assets locais ou com hash (ex: /assets/index-xxx.js), tenta cache primeiro
      const cachedResponse = await caches.match(event.request);
      if (cachedResponse) {
        // Busca na rede em segundo plano para manter cache atualizado (stale-while-revalidate)
        fetch(event.request)
          .then(async (networkResponse) => {
            if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
              const cache = await caches.open(CACHE_NAME);
              cache.put(event.request, networkResponse);
            }
          })
          .catch(() => {});
        return cachedResponse;
      }

      // Se não estiver em cache, busca na rede
      try {
        const networkResponse = await fetch(event.request);
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          event.request.method === 'GET'
        ) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      } catch (err) {
        return cachedResponse || new Response('Offline', { status: 503 });
      }
    })()
  );
});

// =========================================================
// 4. SUPORTE A NOTIFICAÇÕES PUSH NATIVAS (APNs / FCM / Web Push)
// =========================================================

// Evento disparado quando o backend envia uma notificação via APNs/FCM
self.addEventListener('push', (event) => {
  let data = {
    title: 'Teste do backend até os aparelhos...',
    body: 'B6\nEnviado pelo backend de staging via APNs/FCM. Este é um teste de recebimento.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'geopulse-staging-test',
    data: { url: '/' }
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = Object.assign({}, data, parsed);
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const notificationOptions = {
    body: data.body,
    icon: data.icon || '/icon.svg',
    badge: data.badge || '/icon.svg',
    tag: data.tag || ('geopulse-' + Date.now()),
    vibrate: [200, 100, 200, 100, 200],
    data: data.data || { url: '/' },
    requireInteraction: false
  };

  event.waitUntil(
    self.registration.showNotification(data.title, notificationOptions)
  );
});

// Evento disparado quando o usuário toca ou clica na notificação na tela de bloqueio
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Se houver janela aberta do app, foca nela
      for (const client of windowClients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      // Se estiver fechado, abre a aplicação
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// Listener para disparos agendados vindos da interface do app (para testar tela bloqueada com delay)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SCHEDULE_NOTIFICATION') {
    const { title, options, delayMs } = event.data;
    setTimeout(() => {
      self.registration.showNotification(title, options);
    }, delayMs || 0);
  }
});

