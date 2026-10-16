// GeoPulse 2.0 - Core Bootstrap & Orquestrador Central
// Arquitetura Modular, Criptografia E2E AES-256, Multi-Broker Fallback, GPS Adaptativo & UI Apple Maps
import './style.css';
import {
  state,
  initAppState,
  broadcastUserUpdate,
  broadcastRingLocal,
  broadcastCheckinLocal,
  listenToBroadcasts,
  saveMembersToStorage,
  savePlacesToStorage,
  isOnboarded,
} from './sync.js';
import {
  initCircleCrypto,
} from './crypto.js';
import {
  initMap,
  updateAllMarkers,
  updateMarkerForMember,
  removeMarker,
  renderPlaceOverlays,
  switchMapLayer,
  fitAllMembers,
  flyToUser,
  clearActiveRoute,
  setAutoFollowUser,
  getMapInstance,
  TILE_LAYERS,
} from './mapRenderer.js';
import {
  renderMembersList,
  renderPlacesList,
  setupBottomSheet,
  openMemberDetailSheet,
  closeMemberDetailSheet,
  checkMemberLeaveAlerts,
} from './memberPanel.js';
import {
  initModals,
  updateHeaderProfileUI,
  updateNotificationUI,
  showToast,
  openInstallPWAModal,
  openProfileModal,
} from './modals.js';
import {
  openARFinder,
  closeARFinder,
  toggleARTorch,
} from './arFinder.js';
import {
  initChatUI,
  openChatModal,
  closeChatModal,
  handleIncomingChatMessage,
} from './chat.js';
import {
  setupOnboardingModal,
  checkAutoOpenOnboarding,
} from './onboarding.js';
import {
  setupSearch,
} from './search.js';
import {
  startGeolocationTracking,
  setupCompassListener,
} from './gpsTracker.js';
import {
  initRealtimeNetwork,
  broadcastLocation,
  broadcastSOS,
  broadcastGeofenceAlert,
  broadcastCheckin,
} from './realtime.js';
import {
  initP2PNetwork,
} from './p2p.js';
import {
  checkGeofences,
} from './geofence.js';
import {
  initAutoKeepAlive,
  clearMediaSessionWidget,
} from './keepalive.js';
import {
  playTactileClick,
  playRadarPing,
  startSOSAlarm,
  stopSOSAlarm,
  playFindMyChime,
  stopFindMyChime,
  playCheckinSuccess,
} from './audio.js';
import {
  notifySOSAlert,
  notifyFindMyRing,
  notifyMemberJoined,
  notifyGeofenceEvent,
  isStandalone,
} from './notifications.js';
import { eventBus } from './eventBus.js';

let p2pEngine = null;

/* =========================================================
   CHECK-IN RÁPIDO ("CHEGUEI BEM 💚")
========================================================= */
function triggerQuickCheckin() {
  playTactileClick();
  playCheckinSuccess();
  if (navigator.vibrate) {
    try { navigator.vibrate([40, 60, 80]); } catch (e) {}
  }

  const msg = 'Cheguei bem! 💚';
  state.currentUser.activity = '💚 Chegou bem!';
  broadcastCheckin(msg);
  broadcastCheckinLocal(msg);

  showToast('💚 Você avisou a Família que chegou bem!', 'info');

  const btnText = document.querySelector('#btn-trigger-checkin span');
  if (btnText) {
    btnText.textContent = 'Avisado ✓';
    setTimeout(() => {
      if (btnText) btnText.textContent = 'Avisar';
    }, 4000);
  }

  renderMembersList();
  updateMarkerForMember(state.currentUser);
}

function handleIncomingCheckin(payload) {
  if (!payload || !payload.user) return;
  const name = payload.user.name || 'Membro da Família';
  playCheckinSuccess();
  if (navigator.vibrate) {
    try { navigator.vibrate([60, 80]); } catch (e) {}
  }
  showToast(`💚 ${name} avisou: ${payload.message || 'Cheguei bem!'}`, 'info');

  const member = state.members.get(payload.user.id);
  if (member) {
    member.activity = '💚 Chegou bem!';
    renderMembersList();
    updateMarkerForMember(member);
  }
}

/* =========================================================
   SISTEMA DE EMERGÊNCIA SOS & FIND MY RING
========================================================= */
function triggerSOS() {
  state.currentUser.sos = !state.currentUser.sos;
  const banner = document.getElementById('sos-banner');

  if (state.currentUser.sos) {
    startSOSAlarm();
    if (banner) banner.style.display = 'block';
    const authorEl = document.getElementById('sos-author');
    const detailsEl = document.getElementById('sos-details');
    if (authorEl) authorEl.textContent = 'ALERTA SOS ATIVO';
    if (detailsEl) detailsEl.textContent = 'Transmitindo emergência prioritária para todos os membros da família.';

    showToast('🚨 ALERTA SOS ATIVADO! Transmitindo emergência.', 'sos');
    notifySOSAlert(state.currentUser.name);

    const sosPayload = {
      author: state.currentUser.name,
      lat: state.currentUser.lat,
      lng: state.currentUser.lng,
      timestamp: Date.now(),
    };

    broadcastSOS(sosPayload);
    if (p2pEngine?.broadcastSOS) {
      p2pEngine.broadcastSOS(sosPayload);
    }
  } else {
    stopSOSAlarm();
    if (banner) banner.style.display = 'none';
    showToast('Alerta SOS cancelado.', 'info');
  }

  updateAllMarkers();
  broadcastUserUpdate(state.currentUser);
}

function handleIncomingSOS(payload) {
  const author = payload.user?.name || payload.data?.author || payload.name || 'Membro da Família';
  const lat = payload.user?.lat || payload.data?.lat || payload.lat;
  const lng = payload.user?.lng || payload.data?.lng || payload.lng;

  startSOSAlarm();
  if ('vibrate' in navigator) {
    navigator.vibrate([500, 200, 500, 200, 800]);
  }
  notifySOSAlert(author);
  showToast(`🚨 EMERGÊNCIA: ${author} acionou alerta SOS!`, 'sos');

  const banner = document.getElementById('sos-banner');
  const authorEl = document.getElementById('sos-author');
  const detailsEl = document.getElementById('sos-details');
  if (authorEl) authorEl.textContent = `🚨 ALERTA SOS: ${author}`;
  if (detailsEl) detailsEl.textContent = 'Acionou emergência! Toque para localizar no mapa.';
  if (banner) {
    banner.style.display = 'block';
    if (lat && lng) {
      banner.onclick = (e) => {
        if (e.target.id === 'btn-dismiss-sos') return;
        const map = getMapInstance();
        map?.flyTo([lat, lng], 17, { duration: 1.2 });
      };
    }
  }
}

function handleIncomingRing(payload) {
  if (payload.targetId !== state.currentUser.id && payload.targetId !== 'ALL') return;

  playFindMyChime();
  if ('vibrate' in navigator) {
    navigator.vibrate([400, 200, 400, 200, 600]);
  }

  const sender = payload.senderName || 'Alguém da família';
  notifyFindMyRing(sender);

  const modal = document.getElementById('modal-incoming-ring');
  const authorEl = document.getElementById('incoming-ring-author');
  if (authorEl) authorEl.textContent = sender;
  if (modal) modal.style.display = 'flex';
}

function handleMemberJoined(remoteUser, isNewInvite = false) {
  if (!remoteUser || !remoteUser.id || remoteUser.id === state.currentUser.id) return;

  updateMarkerForMember(remoteUser);
  renderMembersList();
  checkActivePlaces();

  let knownNotified = new Set();
  try {
    const list = JSON.parse(sessionStorage.getItem('geopulse_notified_members') || '[]');
    if (Array.isArray(list)) knownNotified = new Set(list);
  } catch (e) {}

  if (!knownNotified.has(remoteUser.id)) {
    knownNotified.add(remoteUser.id);
    try {
      sessionStorage.setItem('geopulse_notified_members', JSON.stringify(Array.from(knownNotified)));
    } catch (e) {}

    playRadarPing();
    if ('vibrate' in navigator) {
      navigator.vibrate([200, 100, 200]);
    }
    const memberName = remoteUser.name || 'Novo aparelho';
    notifyMemberJoined(memberName);
    showToast(`🎉 ${memberName} conectou-se à Família!`, 'info');
  }
}

/* =========================================================
   CHECA LUGARES SALVOS & NOTIFICA CHEGADA E SAÍDA
========================================================= */
const recentGeofenceEvents = new Map();

function isDuplicateGeofenceEvent(fenceId, memberId, type) {
  const key = `${fenceId}_${memberId}_${type}`;
  const lastTime = recentGeofenceEvents.get(key) || 0;
  if (Date.now() - lastTime < 45000) return true;
  recentGeofenceEvents.set(key, Date.now());
  return false;
}

function handleGeofenceAlertNotification(event) {
  if (!event || event.isMe || event.memberId === state.currentUser.id) return;
  if (isDuplicateGeofenceEvent(event.fenceId, event.memberId, event.type)) return;

  const action = event.type === 'ENTERED' ? 'chegou em' : 'saiu de';
  const icon = event.fenceIcon || (event.type === 'ENTERED' ? '🏠' : '📍');
  const notificationTitle = `${icon} ${event.memberName} ${action} ${event.fenceName}`;

  notifyGeofenceEvent(event.memberName, action, event.fenceName, icon);
  showToast(notificationTitle, 'geofence');
  renderPlacesList();
}

function checkActivePlaces() {
  if (state.geofences.length === 0) return;
  const allMembers = [state.currentUser, ...Array.from(state.members.values())];

  checkGeofences(state.geofences, allMembers, (event) => {
    if (event.isMe || event.memberId === state.currentUser.id) {
      broadcastGeofenceAlert(event);
    } else {
      handleGeofenceAlertNotification(event);
    }
    renderPlacesList();
  });
}

/* =========================================================
   CONTROLES DO MAPA (ZOOM, LAYERS, COMPASS, RECENTER)
========================================================= */
function setupMapControls() {
  const btnLayerToggle = document.getElementById('btn-layer-toggle');
  const layerMenu = document.getElementById('layer-popup-menu');
  const btnDark = document.getElementById('btn-layer-dark');
  const btnSat = document.getElementById('btn-layer-satellite');
  const btnStreets = document.getElementById('btn-layer-streets');

  btnLayerToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    playTactileClick();
    if (layerMenu) layerMenu.style.display = layerMenu.style.display === 'none' ? 'flex' : 'none';
  });

  const switchAndClose = (layerKey, activeBtn) => {
    playTactileClick();
    switchMapLayer(layerKey);
    [btnDark, btnSat, btnStreets].forEach((b) => b?.classList.remove('active'));
    activeBtn?.classList.add('active');
    if (layerMenu) layerMenu.style.display = 'none';
  };

  btnDark?.addEventListener('click', () => switchAndClose('dark', btnDark));
  btnSat?.addEventListener('click', () => switchAndClose('satellite', btnSat));
  btnStreets?.addEventListener('click', () => switchAndClose('streets', btnStreets));

  document.addEventListener('click', () => {
    if (layerMenu) layerMenu.style.display = 'none';
  });

  // Seguir GPS
  const btnRecenter = document.getElementById('btn-recenter-floating');
  btnRecenter?.addEventListener('click', () => {
    playTactileClick();
    btnRecenter.classList.add('active-gps');
    flyToUser();
  });

  // Bússola
  const btnCompass = document.getElementById('btn-map-compass');
  btnCompass?.addEventListener('click', async () => {
    playTactileClick();
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res === 'granted') setupCompassListener();
      } catch (e) {}
    }

    const needle = document.getElementById('compass-needle-svg');
    if (needle) {
      needle.style.transition = 'transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';
      needle.style.transform = 'rotate(0deg)';
      setTimeout(() => {
        needle.style.transition = 'transform 0.15s ease-out';
      }, 650);
    }
    flyToUser();
  });

  // Zoom
  document.getElementById('btn-map-zoom-in')?.addEventListener('click', () => {
    playTactileClick();
    const map = getMapInstance();
    map?.zoomIn(1, { animate: true });
  });

  document.getElementById('btn-map-zoom-out')?.addEventListener('click', () => {
    playTactileClick();
    const map = getMapInstance();
    map?.zoomOut(1, { animate: true });
  });

  // Enquadrar Todos
  document.getElementById('btn-fit-all')?.addEventListener('click', () => {
    playTactileClick();
    fitAllMembers();
  });

  // Fechar rota ativa
  document.getElementById('btn-close-route')?.addEventListener('click', clearActiveRoute);
}

/* =========================================================
   SINCRONIZAÇÃO DE REDE: MQTT MULTI-BROKER + P2P + CROSS-TAB
========================================================= */
function setupNetworkConnections() {
  // 1. Cross-Tab Sync (BroadcastChannel)
  listenToBroadcasts(
    () => {
      updateAllMarkers();
      renderMembersList();
      renderPlacesList();
      checkActivePlaces();
    },
    (sosUser) => handleIncomingSOS({ user: sosUser }),
    (ringData) => handleIncomingRing(ringData),
    (joinedUser, isNewInvite) => handleMemberJoined(joinedUser, isNewInvite),
    (deletedMemberId) => {
      removeMarker(deletedMemberId);
      renderMembersList();
      renderPlacesList();
    },
    () => {
      renderPlaceOverlays();
      renderPlacesList();
    },
    (checkinPayload) => handleIncomingCheckin(checkinPayload),
    (chatPayload) => handleIncomingChatMessage(chatPayload)
  );

  // 2. WebRTC P2P
  p2pEngine = initP2PNetwork({
    onPeerConnected: (userOrId, isFirstTimeInvite) => {
      if (typeof userOrId === 'object' && userOrId && userOrId.name) {
        handleMemberJoined(userOrId, isFirstTimeInvite);
      } else {
        renderMembersList();
      }
    },
    onPeerDisconnected: (disconnectedId) => {
      if (disconnectedId) removeMarker(disconnectedId);
      renderMembersList();
      renderPlacesList();
    },
    onLocationReceived: (remoteUser) => {
      updateMarkerForMember(remoteUser);
      renderMembersList();
      checkActivePlaces();
      checkMemberLeaveAlerts(remoteUser);
    },
    onSOSReceived: (payload) => handleIncomingSOS(payload),
    onRingReceived: (payload) => handleIncomingRing(payload),
    onPingUpdated: (peerId, rttMs) => {
      const p2pVal = document.getElementById('p2p-status-val');
      if (p2pVal) p2pVal.textContent = `P2P ${rttMs}ms`;
    },
  });

  // 3. MQTT com Fallback e Criptografia E2E
  initRealtimeNetwork({
    onMemberJoined: (remoteUser, isFirstTimeInvite) => handleMemberJoined(remoteUser, isFirstTimeInvite),
    onMemberUpdated: (remoteUser) => {
      if (remoteUser) updateMarkerForMember(remoteUser);
      renderMembersList();
      checkActivePlaces();
      if (remoteUser) checkMemberLeaveAlerts(remoteUser);
    },
    onPlaceUpdated: () => {
      renderPlaceOverlays();
      renderPlacesList();
    },
    onGeofenceAlertReceived: (event) => handleGeofenceAlertNotification(event),
    onMemberDeleted: (memberId) => {
      removeMarker(memberId);
      renderMembersList();
      renderPlacesList();
    },
    onLocationReceived: (remoteUser) => {
      updateMarkerForMember(remoteUser);
      renderMembersList();
      checkActivePlaces();
      checkMemberLeaveAlerts(remoteUser);
    },
    onSOSReceived: (payload) => handleIncomingSOS(payload),
    onRingReceived: (payload) => handleIncomingRing(payload),
    onCheckinReceived: (payload) => handleIncomingCheckin(payload),
    onChatMessageReceived: (payload) => handleIncomingChatMessage(payload),
    onStatusChanged: ({ status, broker, pendingCount }) => {
      const p2pVal = document.getElementById('p2p-status-val');
      const networkBadge = document.getElementById('network-status-badge');

      if (p2pVal) {
        if (status === 'online') {
          p2pVal.textContent = pendingCount > 0 ? `Sincronizando (${pendingCount})...` : 'E2E Ativo ✓';
        } else if (status === 'reconnecting') {
          p2pVal.textContent = 'Reconectando...';
        } else {
          p2pVal.textContent = 'Modo Offline';
        }
      }

      if (networkBadge) {
        networkBadge.className = `network-pill ${status}`;
        networkBadge.title = `Conexão: ${status} (${broker || ''})`;
      }
    },
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'REQUEST_GPS_SYNC') {
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              broadcastLocation(state.currentUser);
            },
            () => {},
            { enableHighAccuracy: true, timeout: 5000 }
          );
        }
      }
    });

    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then(async (reg) => {
          reg.update();
          updateNotificationUI();

          if ('periodicSync' in reg) {
            try {
              const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
              if (perm.state === 'granted') {
                await reg.periodicSync.register('geopulse-gps-sync', { minInterval: 60 * 1000 });
              }
            } catch (err) {}
          }
        })
        .catch(() => {});
    });
  }
}

// Conexão dos Eventos Globais via EventBus
function bindEventBus() {
  eventBus.on('location:updated', (user) => {
    updateMarkerForMember(user);
    renderMembersList();
    renderPlacesList();
    checkActivePlaces();
  });

  eventBus.on('member:selected', (member) => {
    openMemberDetailSheet(member);
  });

  eventBus.on('modal:open-profile', () => {
    openProfileModal();
  });

  eventBus.on('places:changed', () => {
    renderPlaceOverlays();
    renderPlacesList();
  });

  eventBus.on('user:profile-saved', () => {
    updateMarkerForMember(state.currentUser);
    renderMembersList();
    broadcastLocation(state.currentUser);
    broadcastUserUpdate(state.currentUser);
  });

  eventBus.on('sos:toggle', triggerSOS);
  eventBus.on('sos:dismiss', () => {
    stopSOSAlarm();
    const banner = document.getElementById('sos-banner');
    if (banner) banner.style.display = 'none';
    if (state.currentUser.sos) triggerSOS();
  });

  // Visor Câmera com Realidade Aumentada (AR Precision Finding)
  eventBus.on('member:ar-finder', (member) => {
    openARFinder(member);
  });
}

// Aviso preventivo para manter rastreamento familiar no celular
window.addEventListener('beforeunload', (e) => {
  if (!isStandalone()) {
    e.preventDefault();
    e.returnValue = 'Para continuar transmitindo sua localização para sua família, deixe o app em segundo plano ou instale na tela inicial.';
    return e.returnValue;
  }
});

/* =========================================================
   BOOTSTRAP PRINCIPAL
========================================================= */
document.addEventListener('DOMContentLoaded', async () => {
  clearMediaSessionWidget();
  initAppState();

  // Inicializa Criptografia E2E (gera ou importa chave via fragmento #key=...)
  await initCircleCrypto();

  initMap();
  initAutoKeepAlive();
  startGeolocationTracking();
  registerServiceWorker();

  updateHeaderProfileUI();
  renderMembersList();
  renderPlacesList();
  setupBottomSheet();
  setupMapControls();
  setupSearch();
  initModals();
  setupOnboardingModal();

  bindEventBus();
  setupNetworkConnections();
  updateNotificationUI();

  // Listener para botão de Check-in Rápido ("Cheguei Bem 💚")
  document.getElementById('btn-trigger-checkin')?.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerQuickCheckin();
  });
  document.getElementById('btn-quick-checkin')?.addEventListener('click', () => {
    triggerQuickCheckin();
  });

  // Controles do Visor Câmera AR
  document.getElementById('btn-close-ar')?.addEventListener('click', () => {
    closeARFinder();
  });
  document.getElementById('btn-ar-torch')?.addEventListener('click', async () => {
    await toggleARTorch();
  });

  // Inicializa Chat Privado Criptografado E2E
  initChatUI();

  checkAutoOpenOnboarding();

  // Detecção inteligente de Android para sugerir APK nativo com 24h background tracking
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isDismissed = sessionStorage.getItem('geopulse_dismiss_apk_banner') === 'true';
  const apkBanner = document.getElementById('android-apk-banner');

  if (isAndroid && !isStandalone() && !isDismissed && apkBanner) {
    setTimeout(() => {
      apkBanner.style.display = 'block';
    }, 1500);

    document.getElementById('btn-close-apk-banner')?.addEventListener('click', () => {
      apkBanner.style.display = 'none';
      sessionStorage.setItem('geopulse_dismiss_apk_banner', 'true');
    });
  }

  const triggerDownloadFeedback = (e) => {
    fetch('/geopulse.apk', { method: 'HEAD' })
      .then((res) => {
        if (res.ok) {
          showToast('Baixando geopulse.apk... Toque no arquivo baixado para instalar!', 'info');
        } else {
          // Redireciona para o artefato pronto no GitHub Actions caso ainda não esteja no public
          showToast('Abrindo página de download do APK no GitHub Actions...', 'info');
          setTimeout(() => {
            window.open('https://github.com/andreyborgess/geopulse/actions', '_blank');
          }, 600);
        }
      })
      .catch(() => {
        window.open('https://github.com/andreyborgess/geopulse/actions', '_blank');
      });
  };

  document.getElementById('btn-download-apk-banner')?.addEventListener('click', triggerDownloadFeedback);
  document.getElementById('btn-share-download-apk')?.addEventListener('click', triggerDownloadFeedback);
  document.getElementById('btn-quick-share-download-apk')?.addEventListener('click', triggerDownloadFeedback);

  const urlParams = new URLSearchParams(window.location.search);
  if ((urlParams.get('join') === '1' || urlParams.has('peer')) && !isStandalone() && isOnboarded()) {
    setTimeout(() => {
      openInstallPWAModal(true);
      showToast('Conectado ao círculo! Instale na tela inicial para conexão contínua.', 'info');
    }, 800);
  }
});
