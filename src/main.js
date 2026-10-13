import './style.css';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import {
  playTactileClick,
  playRadarPing,
  startSOSAlarm,
  stopSOSAlarm,
} from './audio.js';
import {
  calculateDistance,
  formatDistance,
  reverseGeocode,
  getDeviceBattery,
  searchAddress,
} from './geo.js';
import {
  state,
  initAppState,
  broadcastUserUpdate,
  listenToBroadcasts,
  addCustomMember,
  removeMember,
  clearAllMembers,
  resetToDemoMembers,
  clearDemoMembers,
  updateUserProfile,
  addSavedPlace,
  removeSavedPlace,
  saveMembersToStorage,
  savePlacesToStorage,
} from './sync.js';
import { checkGeofences } from './geofence.js';
import { generateQRCodeSVG } from './qrcode.js';
import { initP2PNetwork, enableScreenWakeLock } from './p2p.js';
import {
  isPushSupported,
  isIOS,
  isStandalone,
  getPermissionStatus,
  getOrRegisterSubscription,
  requestPushPermission,
  triggerTestPushNotification,
  notifySOSAlert,
  notifyGeofenceEvent,
  getNotificationPreferences,
  saveNotificationPreferences,
} from './notifications.js';

// Coordenadas Centrais de Manaus, Amazonas (Teatro Amazonas / Centro)
export const MANAUS_COORDS = {
  lat: -3.1303,
  lng: -60.0234,
};

/* =========================================================
   VARIÁVEIS DE CONTROLE DO MAPA E CAMADAS
========================================================= */
let map = null;
let currentTileLayer = null;
let activeFocusedMemberId = null;
let autoFollowUser = true;
let p2pEngine = null;
let gpsWatchId = null;
let lastGeocodedAddressCoords = null;
let lastGeocodedAddressTime = 0;
let lastFollowCoords = null;
let activeRoutePolyline = null;
let selectedProfilePhoto = '';

const markersMap = new Map();
const placeCirclesMap = new Map();
const placeMarkersMap = new Map();
let userAccuracyCircle = null;

// Provedores de Tiles 100% Livres de API Key, Rate Limits e Watermarks
const TILE_LAYERS = {
  // Modo Escuro Nativo Oficial Esri (100% Livre de Watermark e API Key)
  dark: L.layerGroup([
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      {
        maxNativeZoom: 16,
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
      }
    ),
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      {
        maxNativeZoom: 16,
        maxZoom: 19,
        pane: 'overlayPane',
      }
    ),
  ]),
  // Modo Satélite Esri de Alta Resolução
  satellite: L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 18,
      attribution: 'Tiles &copy; Esri',
    }
  ),
  // Modo Ruas Natural
  streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }),
};

/* =========================================================
   INICIALIZAÇÃO DO MAPA LEAFLET
========================================================= */
function initMap() {
  const mapElement = document.getElementById('map');
  if (!mapElement) return;

  map = L.map('map', {
    center: [state.currentUser.lat, state.currentUser.lng],
    zoom: 15,
    zoomControl: false,
    attributionControl: false,
  });

  currentTileLayer = TILE_LAYERS.dark;
  currentTileLayer.addTo(map);

  // Desativa recentralização automática se o usuário arrastar o mapa manualmente
  map.on('dragstart', () => {
    autoFollowUser = false;
    const recenterBtn = document.getElementById('btn-recenter-floating');
    if (recenterBtn) recenterBtn.classList.remove('active-gps');
  });

  // Garante renderização integral dos tiles em 100% da tela em qualquer dispositivo
  setTimeout(() => map?.invalidateSize(), 150);
  setTimeout(() => map?.invalidateSize(), 600);

  window.addEventListener('resize', () => {
    if (map) map.invalidateSize();
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 300);
  });

  // Renderiza Lugares Salvos e Membros no Mapa
  renderPlaceOverlays();
  updateAllMarkers();
}

/* =========================================================
   ÍCONES E MARCADORES ESTILO APPLE MAPS
========================================================= */
function createMemberMarkerIcon(member) {
  const isMe = member.isMe;
  const color = member.color || (isMe ? '#007AFF' : '#EC4899');
  const avatarText = member.avatar || member.name.slice(0, 2).toUpperCase();
  const photoUrl = member.photo || '';
  const isMoving = member.speed && member.speed > 5;
  const haloHtml = isMoving ? `<div class="marker-pulse-halo" style="border-color:${color};"></div>` : '';

  const avatarStyle = photoUrl
    ? `background-image: url('${photoUrl}'); background-color: ${color};`
    : `background-color: ${color};`;

  const html = `
    <div class="apple-map-marker">
      <div class="marker-pin-avatar" style="${avatarStyle}">
        ${haloHtml}
        ${photoUrl ? '' : avatarText}
      </div>
      <div class="marker-label-tag">
        ${member.name}
      </div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'apple-leaflet-marker',
    iconSize: [44, 54],
    iconAnchor: [22, 27],
  });
}

function createPlaceMarkerIcon(place) {
  const html = `
    <div class="place-map-marker">
      <div class="place-map-icon" style="border-color:${place.color || '#007AFF'};">
        ${place.icon || '📍'}
      </div>
      <div class="marker-label-tag">
        ${place.name}
      </div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'apple-place-marker',
    iconSize: [36, 46],
    iconAnchor: [18, 23],
  });
}

/* =========================================================
   ATUALIZAÇÃO DE MARCADORES DOS MEMBROS NO MAPA
========================================================= */
function updateMarkerForMember(member) {
  if (!map) return;

  const icon = createMemberMarkerIcon(member);

  if (markersMap.has(member.id)) {
    const existingMarker = markersMap.get(member.id);
    existingMarker.setLatLng([member.lat, member.lng]);
    existingMarker.setIcon(icon);
  } else {
    const marker = L.marker([member.lat, member.lng], { icon }).addTo(map);
    marker.on('click', () => {
      openMemberDetailSheet(member);
    });
    markersMap.set(member.id, marker);
  }
}

function updateAllMarkers() {
  updateMarkerForMember(state.currentUser);
  state.members.forEach((member) => {
    updateMarkerForMember(member);
  });
}

/* =========================================================
   RENDERIZAÇÃO DE LUGARES SALVOS NO MAPA
========================================================= */
function renderPlaceOverlays() {
  if (!map) return;

  // Remove círculos e marcadores de lugares antigos
  placeCirclesMap.forEach((circle) => map.removeLayer(circle));
  placeMarkersMap.forEach((marker) => map.removeLayer(marker));
  placeCirclesMap.clear();
  placeMarkersMap.clear();

  state.geofences.forEach((place) => {
    // Círculo translúcido suave
    const circle = L.circle([place.lat, place.lng], {
      radius: place.radius || 250,
      color: place.color || '#007AFF',
      weight: 1.5,
      opacity: 0.7,
      fillColor: place.color || '#007AFF',
      fillOpacity: 0.12,
    }).addTo(map);

    // Marcador central com ícone
    const icon = createPlaceMarkerIcon(place);
    const marker = L.marker([place.lat, place.lng], { icon }).addTo(map);
    marker.on('click', () => {
      map.flyTo([place.lat, place.lng], 16, { duration: 0.8 });
    });

    placeCirclesMap.set(place.id, circle);
    placeMarkersMap.set(place.id, marker);
  });
}

/* =========================================================
   ROTA AO VIVO ATÉ UM MEMBRO
========================================================= */
function drawRouteToMember(member) {
  if (!map) return;

  // Remove rota anterior se existir
  if (activeRoutePolyline) {
    map.removeLayer(activeRoutePolyline);
    activeRoutePolyline = null;
  }

  const startCoords = [state.currentUser.lat, state.currentUser.lng];
  const destCoords = [member.lat, member.lng];

  // Desenha linha suave estilizada
  activeRoutePolyline = L.polyline([startCoords, destCoords], {
    color: '#007AFF',
    weight: 4,
    opacity: 0.9,
    dashArray: '8, 8',
    lineCap: 'round',
  }).addTo(map);

  map.fitBounds(L.latLngBounds([startCoords, destCoords]), {
    padding: [80, 80],
    maxZoom: 16,
  });

  const distMeters = calculateDistance(
    state.currentUser.lat,
    state.currentUser.lng,
    member.lat,
    member.lng
  );
  const formattedDist = formatDistance(distMeters);
  const etaMinutes = Math.max(2, Math.round((distMeters / 1000) * 2.2));

  // Exibe o banner de rota ativa no topo
  const banner = document.getElementById('active-route-banner');
  const destName = document.getElementById('route-dest-name');
  const metaText = document.getElementById('route-meta-text');
  const btnGoogle = document.getElementById('btn-route-google');

  if (banner && destName && metaText) {
    destName.textContent = `Rota até ${member.name}`;
    metaText.textContent = `${formattedDist} · ~${etaMinutes} min em trânsito`;
    banner.style.display = 'block';

    if (btnGoogle) {
      btnGoogle.onclick = () => {
        const url = `https://www.google.com/maps/dir/?api=1&origin=${state.currentUser.lat},${state.currentUser.lng}&destination=${member.lat},${member.lng}`;
        window.open(url, '_blank');
      };
    }
  }

  state.activeRoute = { destMember: member };
}

function clearActiveRoute() {
  if (activeRoutePolyline && map) {
    map.removeLayer(activeRoutePolyline);
    activeRoutePolyline = null;
  }
  const banner = document.getElementById('active-route-banner');
  if (banner) banner.style.display = 'none';
  state.activeRoute = null;
}

/* =========================================================
   RASTREAMENTO GPS REAL DO CELULAR
========================================================= */
function updateCurrentUserPosition(lat, lng, accuracy = 10, speedKmH = 0) {
  state.currentUser.lat = lat;
  state.currentUser.lng = lng;
  state.currentUser.accuracy = Math.round(accuracy);
  state.currentUser.speed = Math.round(speedKmH);
  state.currentUser.updatedAt = Date.now();

  // Define status de atividade inteligente
  if (speedKmH > 25) {
    state.currentUser.activity = `🚗 Dirigindo · ${Math.round(speedKmH)} km/h`;
  } else if (speedKmH > 3) {
    state.currentUser.activity = `🚶 Caminhando · ${Math.round(speedKmH)} km/h`;
  } else {
    state.currentUser.activity = '📍 Parado';
  }

  // Atualiza círculo de precisão
  if (map) {
    if (userAccuracyCircle) {
      userAccuracyCircle.setLatLng([lat, lng]);
      userAccuracyCircle.setRadius(accuracy);
    } else {
      userAccuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        color: '#007AFF',
        weight: 1,
        fillColor: '#007AFF',
        fillOpacity: 0.08,
      }).addTo(map);
    }
  }

  updateMarkerForMember(state.currentUser);
  renderMembersList();
  renderPlacesList();
  broadcastUserUpdate(state.currentUser);
  if (p2pEngine) {
    p2pEngine.broadcastPosition(state.currentUser);
  }
  checkActivePlaces();
}

function startGeolocationTracking() {
  if (!('geolocation' in navigator)) return;

  const onSuccess = (pos) => {
    const { latitude, longitude, accuracy, speed, heading } = pos.coords;
    const speedKmH = speed ? speed * 3.6 : 0;
    if (heading !== null && heading !== undefined) state.currentUser.heading = heading;

    updateCurrentUserPosition(latitude, longitude, accuracy, speedKmH);

    if (autoFollowUser && map) {
      map.panTo([latitude, longitude], { animate: true, duration: 0.5 });
    }

    // Geocodificação reversa periódica
    throttledReverseGeocode(latitude, longitude);
  };

  const onError = (err) => {
    console.debug('GPS Status:', err.code, err.message);
    const banner = document.getElementById('gps-permission-banner');
    if (err.code === 1 && banner) banner.style.display = 'block';
  };

  navigator.geolocation.getCurrentPosition(onSuccess, onError, {
    enableHighAccuracy: true,
    timeout: 8000,
    maximumAge: 0,
  });

  gpsWatchId = navigator.geolocation.watchPosition(onSuccess, onError, {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 1000,
  });

  // Atualiza bateria real do aparelho
  getDeviceBattery().then((bat) => {
    state.currentUser.battery = bat.level;
    state.currentUser.charging = bat.charging;
    const batEl = document.getElementById('hud-battery');
    if (batEl) batEl.textContent = `${bat.level}%`;
  });
}

function throttledReverseGeocode(lat, lng) {
  const now = Date.now();
  if (now - lastGeocodedAddressTime < 30000) return;
  lastGeocodedAddressTime = now;

  reverseGeocode(lat, lng).then((addr) => {
    if (addr) state.currentUser.address = addr;
  });
}

/* =========================================================
   CHECA LUGARES SALVOS & NOTIFICA CHEGADA E SAÍDA
========================================================= */
function checkActivePlaces() {
  if (state.geofences.length === 0) return;
  const allMembers = [state.currentUser, ...Array.from(state.members.values())];

  checkGeofences(state.geofences, allMembers, (event) => {
    const action = event.type === 'ENTERED' ? 'chegou em' : 'saiu de';
    showToast(`${event.memberName} ${action} ${event.fenceName}.`, 'geofence');
    notifyGeofenceEvent(event.memberName, action, event.fenceName);
    renderPlacesList();
  });
}

/* =========================================================
   RENDERIZAÇÃO DA GAVETA (MEMBROS & LUGARES SALVOS)
========================================================= */
function renderMembersList() {
  const container = document.getElementById('members-list');
  if (!container) return;

  const countBadge = document.getElementById('header-member-count');
  const tabBadge = document.getElementById('tab-badge-people');
  const totalCount = 1 + state.members.size;

  if (countBadge) countBadge.textContent = totalCount;
  if (tabBadge) tabBadge.textContent = totalCount;

  const allMembers = [state.currentUser, ...Array.from(state.members.values())];

  const membersCardsHtml = allMembers
    .map((member) => {
      const isMe = member.isMe;
      const avatarText = member.avatar || member.name.slice(0, 2).toUpperCase();
      const color = member.color || (isMe ? '#007AFF' : '#EC4899');
      const photo = member.photo || '';
      const avatarStyle = photo
        ? `background-image: url('${photo}'); background-color: ${color};`
        : `background-color: ${color};`;

      const dist = isMe
        ? ''
        : formatDistance(
            calculateDistance(
              state.currentUser.lat,
              state.currentUser.lng,
              member.lat,
              member.lng
            )
          );

      const relationText = isMe ? 'Você (Organizador)' : member.relation || 'Membro do Círculo';

      return `
        <div class="member-card ${state.selectedMemberId === member.id ? 'active-selected' : ''}" data-id="${member.id}">
          <div class="card-avatar-wrapper">
            <div class="card-avatar" style="${avatarStyle}">
              ${photo ? '' : avatarText}
            </div>
            <span class="card-avatar-dot"></span>
          </div>
          <div class="card-info">
            <div class="card-name-row">
              <strong class="card-name">${member.name}</strong>
              <span class="card-battery">🔋 ${member.battery || 88}%</span>
            </div>
            <div class="card-activity-row">
              <span class="card-activity">${member.activity || relationText}</span>
              ${dist ? `<span class="card-distance">${dist}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  const emptyCardHtml = state.members.size === 0 ? `
    <div class="empty-members-card" id="card-empty-invite" title="Conectar outro celular">
      <div class="empty-members-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </div>
      <div class="empty-members-text">
        <strong>Conectar Novo Aparelho</strong>
        <span>Toque para gerar o QR Code e conectar o celular da família em tempo real.</span>
      </div>
    </div>
  ` : '';

  container.innerHTML = membersCardsHtml + emptyCardHtml;

  // Evento de clique no card vazio para convidar
  document.getElementById('card-empty-invite')?.addEventListener('click', () => {
    playTactileClick();
    openShareModal();
  });

  // Evento de clique para abrir a ficha de detalhes
  container.querySelectorAll('.member-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      const member =
        id === state.currentUser.id
          ? state.currentUser
          : state.members.get(id);
      if (member) openMemberDetailSheet(member);
    });
  });
}

function renderPlacesList() {
  const container = document.getElementById('places-list');
  if (!container) return;

  const tabBadge = document.getElementById('tab-badge-places');
  if (tabBadge) tabBadge.textContent = state.geofences.length;

  const allMembers = [state.currentUser, ...Array.from(state.members.values())];

  container.innerHTML = state.geofences
    .map((place) => {
      // Descobre quem está neste lugar agora
      const peopleInside = allMembers.filter((m) => {
        return calculateDistance(place.lat, place.lng, m.lat, m.lng) <= place.radius;
      });

      const presenceText =
        peopleInside.length > 0
          ? `${peopleInside.length} presente(s): ${peopleInside.map((p) => p.isMe ? 'Você' : p.name.split(' ')[0]).join(', ')}`
          : 'Ninguém neste local agora';

      return `
        <div class="place-card" data-id="${place.id}">
          <div class="place-icon-box" style="border-color:${place.color};">
            ${place.icon || '📍'}
          </div>
          <div class="place-info">
            <strong class="place-name">${place.name}</strong>
            <span class="place-presence">${presenceText}</span>
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.place-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      const place = state.geofences.find((p) => p.id === id);
      if (place && map) {
        playTactileClick();
        map.flyTo([place.lat, place.lng], 16, { duration: 0.8 });
      }
    });
  });
}

/* =========================================================
   FICHA COMPLETA DO MEMBRO (MEMBER DETAIL SHEET)
========================================================= */
function openMemberDetailSheet(member) {
  playTactileClick();
  state.selectedMemberId = member.id;

  const sheet = document.getElementById('member-detail-sheet');
  const avatarEl = document.getElementById('detail-avatar');
  const nameEl = document.getElementById('detail-name');
  const relationEl = document.getElementById('detail-relation');
  const activityIcon = document.getElementById('detail-activity-icon');
  const activityText = document.getElementById('detail-activity-text');
  const addressEl = document.getElementById('detail-address');
  const batteryEl = document.getElementById('detail-battery');
  const speedEl = document.getElementById('detail-speed');
  const distanceEl = document.getElementById('detail-distance');
  const updatedEl = document.getElementById('detail-updated');

  if (avatarEl) {
    if (member.photo) {
      avatarEl.style.backgroundImage = `url('${member.photo}')`;
      avatarEl.textContent = '';
    } else {
      avatarEl.style.backgroundImage = '';
      avatarEl.textContent = member.avatar || member.name.slice(0, 2).toUpperCase();
    }
    avatarEl.style.backgroundColor = member.color || '#007AFF';
  }

  if (nameEl) nameEl.textContent = member.name;
  if (relationEl) relationEl.textContent = member.isMe ? 'Você · Organizador' : member.relation || 'Família Silva';
  if (activityText) activityText.textContent = member.activity || 'Localização Ativa';
  if (addressEl) addressEl.textContent = member.address || 'Adrianópolis, Manaus';
  if (batteryEl) batteryEl.textContent = `${member.battery || 88}%`;
  if (speedEl) speedEl.textContent = `${member.speed || 0} km/h`;

  const distMeters = member.isMe
    ? 0
    : calculateDistance(state.currentUser.lat, state.currentUser.lng, member.lat, member.lng);
  if (distanceEl) distanceEl.textContent = member.isMe ? 'Aqui' : formatDistance(distMeters);
  if (updatedEl) updatedEl.textContent = 'Agora';

  // Configura botão de Traçar Rota
  const btnRoute = document.getElementById('btn-action-route');
  if (btnRoute) {
    btnRoute.onclick = () => {
      playTactileClick();
      drawRouteToMember(member);
      closeMemberDetailSheet();
    };
  }

  // Configura botão de Tocar Som (Ping)
  const btnPing = document.getElementById('btn-action-ping');
  if (btnPing) {
    btnPing.onclick = () => {
      playRadarPing();
      showToast(`Sinal sonoro enviado para ${member.name}.`, 'info');
    };
  }

  // Configura botão de Aviso ao Sair
  const btnNotify = document.getElementById('btn-action-notify');
  if (btnNotify) {
    btnNotify.onclick = () => {
      playTactileClick();
      showToast(`Você será avisado quando ${member.name} sair da área.`, 'info');
    };
  }

  // Configura botão Google Maps Externo
  const btnExt = document.getElementById('btn-action-external-maps');
  if (btnExt) {
    btnExt.onclick = () => {
      const url = `https://www.google.com/maps/dir/?api=1&origin=${state.currentUser.lat},${state.currentUser.lng}&destination=${member.lat},${member.lng}`;
      window.open(url, '_blank');
    };
  }

  // Centraliza o mapa suavemente no membro
  if (map) {
    map.flyTo([member.lat, member.lng], 16, { duration: 0.8 });
  }

  if (sheet) sheet.style.display = 'flex';
}

function closeMemberDetailSheet() {
  playTactileClick();
  const sheet = document.getElementById('member-detail-sheet');
  if (sheet) sheet.style.display = 'none';
  state.selectedMemberId = null;
}

/* =========================================================
   COMPRESSÃO E TRATAMENTO DE IMAGEM DA GALERIA
========================================================= */
function compressImageFile(file, maxSize = 240, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      return reject(new Error('Selecione uma imagem válida da galeria.'));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Erro ao ler a foto do celular.'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Não foi possível carregar a imagem.'));
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = maxSize;
          canvas.height = maxSize;
          const ctx = canvas.getContext('2d');

          // Corte quadrado centralizado proporcional
          const minSide = Math.min(img.width, img.height);
          const startX = (img.width - minSide) / 2;
          const startY = (img.height - minSide) / 2;

          ctx.drawImage(img, startX, startY, minSide, minSide, 0, 0, maxSize, maxSize);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          resolve(dataUrl);
        } catch (err) {
          reject(err);
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function updateHeaderProfileUI() {
  const headerAvatar = document.getElementById('header-user-avatar');
  if (headerAvatar) {
    if (state.currentUser.photo) {
      headerAvatar.style.backgroundImage = `url('${state.currentUser.photo}')`;
      headerAvatar.textContent = '';
    } else {
      headerAvatar.style.backgroundImage = '';
      headerAvatar.textContent = state.currentUser.avatar || 'VC';
    }
  }
}

/* =========================================================
   MODAL MEU PERFIL
========================================================= */
function openProfileModal() {
  playTactileClick();
  const modal = document.getElementById('modal-profile');
  const inputName = document.getElementById('input-profile-name');
  const previewName = document.getElementById('profile-edit-name-preview');
  const previewAvatar = document.getElementById('profile-edit-avatar-preview');
  const btnRemovePhoto = document.getElementById('btn-remove-custom-photo');

  if (inputName) inputName.value = state.currentUser.name;
  if (previewName) previewName.textContent = state.currentUser.name;

  selectedProfilePhoto = state.currentUser.photo || '';

  if (previewAvatar) {
    if (selectedProfilePhoto) {
      previewAvatar.style.backgroundImage = `url('${selectedProfilePhoto}')`;
      previewAvatar.textContent = '';
    } else {
      previewAvatar.style.backgroundImage = '';
      previewAvatar.textContent = state.currentUser.avatar;
    }
  }

  if (btnRemovePhoto) {
    btnRemovePhoto.style.display = selectedProfilePhoto ? 'block' : 'none';
  }

  document.querySelectorAll('.avatar-choice-btn').forEach((btn) => {
    const photo = btn.getAttribute('data-photo') || '';
    if (photo === selectedProfilePhoto) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (modal) modal.style.display = 'flex';
}

function closeProfileModal() {
  playTactileClick();
  const modal = document.getElementById('modal-profile');
  if (modal) modal.style.display = 'none';
}

/* =========================================================
   MODAL NOVO LUGAR SALVO
========================================================= */
function openPlaceModal() {
  playTactileClick();
  const modal = document.getElementById('modal-place');
  if (modal) modal.style.display = 'flex';
}

function closePlaceModal() {
  playTactileClick();
  const modal = document.getElementById('modal-place');
  if (modal) modal.style.display = 'none';
}

/* =========================================================
   MODAL COMPARTILHAR CÍRCULO & QR CODE REAL
========================================================= */
async function openShareModal() {
  playTactileClick();
  const modal = document.getElementById('modal-share');
  const linkInput = document.getElementById('share-link-input');
  const qrContainer = document.getElementById('qr-container');
  const modalCircleCode = document.getElementById('modal-circle-code');

  if (modalCircleCode) {
    modalCircleCode.textContent = state.circleId;
  }

  // Se o usuário estiver no localhost, usa a URL oficial de produção na Vercel
  // para que o QR Code lido pela câmera de outro celular funcione imediatamente!
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const baseUrl = isLocal ? 'https://loc-sigma-mauve.vercel.app' : window.location.origin;

  const peerParam = p2pEngine ? `&peer=${encodeURIComponent(p2pEngine.getMyPeerId())}` : '';
  const inviteUrl = `${baseUrl}/?circle=${encodeURIComponent(state.circleId)}${peerParam}&join=1`;

  if (linkInput) linkInput.value = inviteUrl;

  if (qrContainer) {
    qrContainer.innerHTML = '<div style="padding: 24px; font-size: 13px; color: var(--text-muted); text-align: center;">Gerando QR Code oficial...</div>';
    try {
      const svg = await generateQRCodeSVG(inviteUrl);
      qrContainer.innerHTML = svg;
    } catch (err) {
      console.error('Falha ao renderizar QR Code:', err);
      qrContainer.innerHTML = `<div style="color: #ff3b30; font-size: 12px; padding: 16px;">Erro: ${err.message}</div>`;
    }
  }

  if (modal) modal.style.display = 'flex';
}

function closeShareModal() {
  playTactileClick();
  const modal = document.getElementById('modal-share');
  if (modal) modal.style.display = 'none';
}

/* =========================================================
   INSTALAÇÃO PWA DIRETA NO CELULAR (ANDROID / IPHONE)
========================================================= */
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const nativeBox = document.getElementById('pwa-native-install-box');
  if (nativeBox) nativeBox.style.display = 'block';
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  const nativeBox = document.getElementById('pwa-native-install-box');
  if (nativeBox) nativeBox.style.display = 'none';
  showToast('GeoPulse instalado com sucesso no seu celular!', 'info');
  closeInstallPWAModal();
});

async function triggerPWAInstall() {
  playTactileClick();
  if (deferredPrompt) {
    try {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        showToast('Instalando GeoPulse...', 'info');
      }
      deferredPrompt = null;
      const nativeBox = document.getElementById('pwa-native-install-box');
      if (nativeBox) nativeBox.style.display = 'none';
    } catch (e) {
      console.error('Erro no prompt de instalação:', e);
    }
  } else if (isIOS()) {
    showToast('No Safari: Toque no botão Compartilhar e depois em "Adicionar à Tela de Início".', 'info');
  } else {
    showToast('Toque no menu (⋮) do seu navegador e selecione "Instalar aplicativo" ou "Adicionar à tela inicial".', 'info');
  }
}

function openInstallPWAModal(isDirectInvite = false) {
  playTactileClick();
  const modal = document.getElementById('modal-install-pwa');
  const circleTitle = document.getElementById('pwa-circle-title');
  const nativeBox = document.getElementById('pwa-native-install-box');
  const iosBox = document.getElementById('pwa-ios-guide-box');

  if (circleTitle) {
    circleTitle.textContent = isDirectInvite
      ? `Você foi conectado ao Círculo "${state.circleId}"!`
      : 'Instale o GeoPulse no seu Celular';
  }

  if (isIOS()) {
    if (nativeBox) nativeBox.style.display = 'none';
    if (iosBox) iosBox.style.display = 'flex';
  } else {
    if (nativeBox) nativeBox.style.display = 'block';
    if (iosBox) iosBox.style.display = deferredPrompt ? 'none' : 'flex';
  }

  if (modal) modal.style.display = 'flex';
}

function closeInstallPWAModal() {
  playTactileClick();
  const modal = document.getElementById('modal-install-pwa');
  if (modal) modal.style.display = 'none';
}

function checkAutoOpenPWAInstall() {
  const urlParams = new URLSearchParams(window.location.search);
  const isJoin = urlParams.get('join') === '1' || urlParams.has('peer');

  // Se o usuário veio de um escaneamento do QR Code e ainda não está em modo PWA nativo instalado
  if (isJoin && !isStandalone()) {
    setTimeout(() => {
      openInstallPWAModal(true);
      showToast(`Conectado ao círculo! Instale como aplicativo para manter conexão contínua.`, 'info');
    }, 800);
  }
}

/* =========================================================
   CENTRAL DE NOTIFICAÇÕES PUSH
========================================================= */
function updateNotificationUI() {
  const perm = getPermissionStatus();
  const indicator = document.getElementById('notif-status-indicator');
  const title = document.getElementById('notif-status-title');
  const sub = document.getElementById('notif-status-sub');
  const btnPerm = document.getElementById('btn-request-notification-perm');
  const headerDot = document.getElementById('header-notif-dot');
  const iosBanner = document.getElementById('notif-ios-banner');
  const subJsonCode = document.getElementById('sub-json-code');

  if (headerDot) {
    headerDot.className = 'header-notif-dot ' + (perm === 'granted' ? 'granted' : perm === 'denied' ? 'denied' : '');
  }

  if (iosBanner) {
    iosBanner.style.display = isIOS() ? 'block' : 'none';
  }

  if (indicator && title && sub && btnPerm) {
    indicator.className = 'notif-status-indicator ' + (perm === 'granted' ? 'granted' : perm === 'denied' ? 'denied' : '');

    if (perm === 'granted') {
      title.textContent = 'Notificações Ativas';
      sub.textContent = 'Aparelho pronto para receber alertas na tela de bloqueio.';
      btnPerm.disabled = true;
      btnPerm.innerHTML = '<span>Permitido ✓</span>';
    } else if (perm === 'denied') {
      title.textContent = 'Permissão Bloqueada';
      sub.textContent = 'Permissão bloqueada no navegador ou Ajustes do iPhone.';
      btnPerm.disabled = true;
      btnPerm.innerHTML = '<span>Bloqueado</span>';
    } else {
      title.textContent = 'Permissão Pendente';
      sub.textContent = 'Autorize notificações para receber avisos de chegada e saída.';
      btnPerm.disabled = false;
      btnPerm.innerHTML = '<span>Ativar no Aparelho</span>';
    }
  }

  if (subJsonCode) {
    getOrRegisterSubscription().then((subObj) => {
      subJsonCode.textContent = subObj ? JSON.stringify(subObj, null, 2) : 'Clique em "Ativar no Aparelho".';
    }).catch(() => {
      subJsonCode.textContent = 'Sem subscrição ativa.';
    });
  }

  const prefs = getNotificationPreferences();
  const prefSos = document.getElementById('pref-sos-notif');
  const prefFence = document.getElementById('pref-fence-notif');
  if (prefSos) prefSos.checked = prefs.sos !== false;
  if (prefFence) prefFence.checked = prefs.fence !== false;
}

function openNotificationsModal() {
  playTactileClick();
  updateNotificationUI();
  const modal = document.getElementById('modal-notifications');
  if (modal) modal.style.display = 'flex';
}

function closeNotificationsModal() {
  playTactileClick();
  const modal = document.getElementById('modal-notifications');
  if (modal) modal.style.display = 'none';
}

/* =========================================================
   SISTEMA DE EMERGÊNCIA SOS
========================================================= */
function triggerSOS() {
  state.currentUser.sos = !state.currentUser.sos;
  const banner = document.getElementById('sos-banner');

  if (state.currentUser.sos) {
    startSOSAlarm();
    if (banner) banner.style.display = 'block';
    showToast('ALERTA SOS ATIVADO! Transmitindo emergência.', 'sos');
    notifySOSAlert(state.currentUser.name);

    if (p2pEngine) {
      p2pEngine.broadcastSOS({
        author: state.currentUser.name,
        lat: state.currentUser.lat,
        lng: state.currentUser.lng,
        timestamp: Date.now(),
      });
    }
  } else {
    stopSOSAlarm();
    if (banner) banner.style.display = 'none';
    showToast('Alerta SOS cancelado.', 'info');
  }

  updateAllMarkers();
  broadcastUserUpdate(state.currentUser);
}

/* =========================================================
   TOAST NOTIFICATIONS
========================================================= */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

/* =========================================================
   CONTROLES E EVENTOS DA UI
========================================================= */
function setupUIEventListeners() {
  // Alternador de Camadas
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

  const switchLayer = (layer, activeBtn) => {
    playTactileClick();
    if (currentTileLayer) map.removeLayer(currentTileLayer);
    currentTileLayer = layer;
    currentTileLayer.addTo(map);
    [btnDark, btnSat, btnStreets].forEach((b) => b?.classList.remove('active'));
    activeBtn?.classList.add('active');
    if (layerMenu) layerMenu.style.display = 'none';
  };

  btnDark?.addEventListener('click', () => switchLayer(TILE_LAYERS.dark, btnDark));
  btnSat?.addEventListener('click', () => switchLayer(TILE_LAYERS.satellite, btnSat));
  btnStreets?.addEventListener('click', () => switchLayer(TILE_LAYERS.streets, btnStreets));

  document.addEventListener('click', () => {
    if (layerMenu) layerMenu.style.display = 'none';
  });

  // Recentralizar / Seguir GPS (Seta Azul Apple)
  const btnRecenter = document.getElementById('btn-recenter-floating');
  btnRecenter?.addEventListener('click', () => {
    playTactileClick();
    autoFollowUser = true;
    btnRecenter.classList.add('active-gps');
    if (map) {
      map.flyTo([state.currentUser.lat, state.currentUser.lng], 16, { duration: 0.8 });
    }
  });

  // Botão Centralizar em Manaus
  document.getElementById('btn-goto-manaus')?.addEventListener('click', () => {
    playTactileClick();
    if (map) map.flyTo([MANAUS_COORDS.lat, MANAUS_COORDS.lng], 14, { duration: 0.8 });
  });

  // Enquadrar Todos no Círculo
  document.getElementById('btn-fit-all')?.addEventListener('click', () => {
    playTactileClick();
    if (!map) return;
    const allCoords = [
      [state.currentUser.lat, state.currentUser.lng],
      ...Array.from(state.members.values()).map((m) => [m.lat, m.lng]),
    ];
    map.fitBounds(L.latLngBounds(allCoords), { padding: [60, 60], maxZoom: 16 });
  });

  // Fechar rota ativa
  document.getElementById('btn-close-route')?.addEventListener('click', clearActiveRoute);

  // Controle Dinâmico da Gaveta Inferior (Apple Find My Sheet)
  const mainContainer = document.querySelector('.main-container');
  const sidebar = document.getElementById('sidebar');
  const sheetHandle = document.getElementById('sheet-handle');
  const sheetTabsRow = document.querySelector('.sheet-tabs-row');

  const setSheetCollapsed = (collapsed) => {
    if (collapsed) {
      mainContainer?.classList.add('sheet-collapsed');
      sidebar?.classList.add('collapsed');
    } else {
      mainContainer?.classList.remove('sheet-collapsed');
      sidebar?.classList.remove('collapsed');
    }
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 320);
  };

  const toggleSheet = () => {
    playTactileClick();
    const isCollapsed =
      mainContainer?.classList.contains('sheet-collapsed') ||
      sidebar?.classList.contains('collapsed');
    setSheetCollapsed(!isCollapsed);
  };

  sheetHandle?.addEventListener('click', toggleSheet);

  // Gesto Touch Swipe (Deslizar para cima/baixo na aba da gaveta)
  let sheetTouchStartY = 0;
  const sheetTouchArea = sheetHandle || sheetTabsRow;
  sheetTouchArea?.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length > 0) {
      sheetTouchStartY = e.touches[0].clientY;
    }
  }, { passive: true });

  sheetTouchArea?.addEventListener('touchend', (e) => {
    if (e.changedTouches && e.changedTouches.length > 0) {
      const diff = e.changedTouches[0].clientY - sheetTouchStartY;
      if (diff > 35) {
        setSheetCollapsed(true);
        playTactileClick();
      } else if (diff < -35) {
        setSheetCollapsed(false);
        playTactileClick();
      }
    }
  }, { passive: true });

  // Abas da Gaveta (Pessoas vs Lugares)
  const tabPeople = document.getElementById('tab-btn-people');
  const tabPlaces = document.getElementById('tab-btn-places');
  const panelPeople = document.getElementById('panel-people');
  const panelPlaces = document.getElementById('panel-places');

  tabPeople?.addEventListener('click', () => {
    playTactileClick();
    tabPeople.classList.add('active');
    tabPlaces?.classList.remove('active');
    if (panelPeople) panelPeople.style.display = 'flex';
    if (panelPlaces) panelPlaces.style.display = 'none';
    setSheetCollapsed(false);
  });

  tabPlaces?.addEventListener('click', () => {
    playTactileClick();
    tabPlaces.classList.add('active');
    tabPeople?.classList.remove('active');
    if (panelPlaces) panelPlaces.style.display = 'flex';
    if (panelPeople) panelPeople.style.display = 'none';
    setSheetCollapsed(false);
  });

  // Botão Rápido + no cabeçalho da gaveta
  document.getElementById('btn-sheet-quick-add')?.addEventListener('click', () => {
    if (tabPlaces?.classList.contains('active')) {
      openPlaceModal();
    } else {
      openShareModal();
    }
  });

  // Conectar novo aparelho / Guia de Instalação PWA
  document.getElementById('btn-invite-flow')?.addEventListener('click', openShareModal);
  document.getElementById('btn-open-install-guide')?.addEventListener('click', () => openInstallPWAModal(false));
  document.getElementById('btn-close-install-modal')?.addEventListener('click', closeInstallPWAModal);
  document.getElementById('btn-continue-in-browser')?.addEventListener('click', closeInstallPWAModal);
  document.getElementById('btn-trigger-pwa-install')?.addEventListener('click', triggerPWAInstall);

  // Abertura e fechamento de Modais
  document.getElementById('btn-share-circle')?.addEventListener('click', openShareModal);
  document.getElementById('btn-circle-info')?.addEventListener('click', openShareModal);
  document.getElementById('btn-close-share-modal')?.addEventListener('click', closeShareModal);

  document.getElementById('btn-open-notifications-modal')?.addEventListener('click', openNotificationsModal);
  document.getElementById('btn-close-notifications-modal')?.addEventListener('click', closeNotificationsModal);

  document.getElementById('btn-my-profile')?.addEventListener('click', openProfileModal);
  document.getElementById('btn-close-profile-modal')?.addEventListener('click', closeProfileModal);
  document.getElementById('btn-cancel-profile')?.addEventListener('click', closeProfileModal);

  document.getElementById('btn-open-place-modal')?.addEventListener('click', openPlaceModal);
  document.getElementById('btn-close-place-modal')?.addEventListener('click', closePlaceModal);
  document.getElementById('btn-cancel-place')?.addEventListener('click', closePlaceModal);

  document.getElementById('btn-close-member-detail')?.addEventListener('click', closeMemberDetailSheet);

  // Upload e Seleção de Foto da Galeria do Celular
  const inputProfileFile = document.getElementById('input-profile-photo-file');
  const btnPickGallery = document.getElementById('btn-pick-from-gallery');
  const btnTriggerAvatar = document.getElementById('btn-trigger-avatar-click');
  const btnTriggerBadge = document.getElementById('btn-trigger-badge-click');
  const previewAvatar = document.getElementById('profile-edit-avatar-preview');
  const btnRemovePhoto = document.getElementById('btn-remove-custom-photo');

  const openPhoneGallery = () => {
    playTactileClick();
    inputProfileFile?.click();
  };

  btnPickGallery?.addEventListener('click', openPhoneGallery);
  btnTriggerAvatar?.addEventListener('click', openPhoneGallery);
  btnTriggerBadge?.addEventListener('click', openPhoneGallery);

  inputProfileFile?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      showToast('Processando foto...', 'info');
      const compressedDataUrl = await compressImageFile(file, 240, 0.85);
      selectedProfilePhoto = compressedDataUrl;

      if (previewAvatar) {
        previewAvatar.style.backgroundImage = `url('${selectedProfilePhoto}')`;
        previewAvatar.textContent = '';
      }

      if (btnRemovePhoto) btnRemovePhoto.style.display = 'block';

      document.querySelectorAll('.avatar-choice-btn').forEach((b) => b.classList.remove('active'));

      showToast('Foto carregada da galeria!', 'info');
      playTactileClick();
    } catch (err) {
      showToast('Erro ao carregar foto: ' + err.message, 'error');
    } finally {
      inputProfileFile.value = '';
    }
  });

  btnRemovePhoto?.addEventListener('click', (e) => {
    e.stopPropagation();
    playTactileClick();
    selectedProfilePhoto = '';
    if (previewAvatar) {
      previewAvatar.style.backgroundImage = '';
      previewAvatar.textContent = state.currentUser.avatar;
    }
    btnRemovePhoto.style.display = 'none';

    document.querySelectorAll('.avatar-choice-btn').forEach((b) => {
      if ((b.getAttribute('data-photo') || '') === '') {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });
    showToast('Foto removida.', 'info');
  });

  document.querySelectorAll('.avatar-choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.avatar-choice-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedProfilePhoto = btn.getAttribute('data-photo') || '';
      if (previewAvatar) {
        if (selectedProfilePhoto) {
          previewAvatar.style.backgroundImage = `url('${selectedProfilePhoto}')`;
          previewAvatar.textContent = '';
        } else {
          previewAvatar.style.backgroundImage = '';
          previewAvatar.textContent = state.currentUser.avatar;
        }
      }
      if (btnRemovePhoto) {
        btnRemovePhoto.style.display = selectedProfilePhoto ? 'block' : 'none';
      }
    });
  });

  document.getElementById('btn-save-profile')?.addEventListener('click', () => {
    playTactileClick();
    const nameInput = document.getElementById('input-profile-name');
    const newName = nameInput?.value.trim() || 'Você';
    updateUserProfile(newName, selectedProfilePhoto);

    updateHeaderProfileUI();
    updateMarkerForMember(state.currentUser);
    renderMembersList();
    closeProfileModal();
    showToast('Perfil atualizado com sucesso!', 'info');
  });

  // Salvar Lugar
  let selectedCategory = 'home';
  let selectedIcon = '🏠';
  let selectedColor = '#007AFF';

  document.querySelectorAll('.cat-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.cat-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      selectedCategory = chip.getAttribute('data-cat') || 'home';
      selectedIcon = chip.getAttribute('data-icon') || '🏠';
      selectedColor = chip.getAttribute('data-color') || '#007AFF';
    });
  });

  const sliderRadius = document.getElementById('place-radius-slider');
  const labelRadius = document.getElementById('place-radius-val');
  sliderRadius?.addEventListener('input', (e) => {
    if (labelRadius) labelRadius.textContent = `${e.target.value}m`;
  });

  document.getElementById('btn-save-place')?.addEventListener('click', () => {
    playTactileClick();
    const nameInput = document.getElementById('place-name-input');
    const name = nameInput?.value.trim() || 'Novo Lugar';
    const radius = parseInt(sliderRadius?.value || '250', 10);
    const center = map ? map.getCenter() : { lat: state.currentUser.lat, lng: state.currentUser.lng };

    addSavedPlace({
      id: `place_${Date.now()}`,
      name,
      category: selectedCategory,
      icon: selectedIcon,
      color: selectedColor,
      lat: center.lat,
      lng: center.lng,
      radius,
      address: 'Manaus, AM',
    });

    renderPlaceOverlays();
    renderPlacesList();
    closePlaceModal();
    showToast(`Lugar "${name}" adicionado com sucesso!`, 'geofence');
  });

  // Botão SOS com confirmação
  const modalSosConfirm = document.getElementById('modal-sos-confirm');
  document.getElementById('btn-sos')?.addEventListener('click', () => {
    playTactileClick();
    if (state.currentUser.sos) {
      triggerSOS(); // Desativa direto se já estiver ativo
    } else if (modalSosConfirm) {
      modalSosConfirm.style.display = 'flex';
    }
  });

  document.getElementById('btn-confirm-sos')?.addEventListener('click', () => {
    playTactileClick();
    if (modalSosConfirm) modalSosConfirm.style.display = 'none';
    triggerSOS();
  });

  document.getElementById('btn-cancel-sos')?.addEventListener('click', () => {
    playTactileClick();
    if (modalSosConfirm) modalSosConfirm.style.display = 'none';
  });

  document.getElementById('btn-close-sos-confirm')?.addEventListener('click', () => {
    playTactileClick();
    if (modalSosConfirm) modalSosConfirm.style.display = 'none';
  });

  document.getElementById('btn-dismiss-sos')?.addEventListener('click', triggerSOS);

  // Busca de Endereços
  const searchInput = document.getElementById('map-search-input');
  const searchDropdown = document.getElementById('search-dropdown');
  let searchTimeout = null;

  searchInput?.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    if (searchTimeout) clearTimeout(searchTimeout);
    if (!query) {
      if (searchDropdown) searchDropdown.style.display = 'none';
      return;
    }

    searchTimeout = setTimeout(async () => {
      const results = await searchAddress(query);
      if (searchDropdown) {
        searchDropdown.innerHTML = results
          .map((res) => `<div class="search-item" data-lat="${res.lat}" data-lng="${res.lon}">📍 ${res.display_name}</div>`)
          .join('');
        searchDropdown.style.display = results.length > 0 ? 'block' : 'none';

        searchDropdown.querySelectorAll('.search-item').forEach((item) => {
          item.addEventListener('click', () => {
            const lat = parseFloat(item.getAttribute('data-lat'));
            const lng = parseFloat(item.getAttribute('data-lng'));
            if (map && !isNaN(lat) && !isNaN(lng)) {
              playTactileClick();
              map.flyTo([lat, lng], 16, { duration: 1 });
            }
            searchDropdown.style.display = 'none';
          });
        });
      }
    }, 350);
  });

  // Copiar Links e Código
  document.getElementById('btn-copy-code')?.addEventListener('click', () => {
    playTactileClick();
    navigator.clipboard.writeText(state.circleId);
    showToast('Código copiado!', 'info');
  });

  document.getElementById('btn-copy-link')?.addEventListener('click', () => {
    playTactileClick();
    const linkInput = document.getElementById('share-link-input');
    if (linkInput) {
      navigator.clipboard.writeText(linkInput.value);
      showToast('Link do círculo copiado!', 'info');
    }
  });

  // Controles de Notificações
  document.getElementById('btn-request-notification-perm')?.addEventListener('click', async () => {
    playTactileClick();
    try {
      const res = await requestPushPermission();
      showToast(res.permission === 'granted' ? 'Notificações autorizadas!' : 'Permissão negada.', 'info');
      updateNotificationUI();
    } catch (e) {
      showToast('Erro: ' + e.message, 'error');
    }
  });

  document.getElementById('btn-test-notification-now')?.addEventListener('click', async () => {
    playTactileClick();
    try {
      await triggerTestPushNotification({ delaySeconds: 0 });
      showToast('Notificação enviada!', 'info');
      updateNotificationUI();
    } catch (e) {
      showToast('Erro: ' + e.message, 'error');
    }
  });

  let delayTimer = null;
  document.getElementById('btn-test-notification-delay')?.addEventListener('click', async () => {
    playTactileClick();
    if (delayTimer) return;
    try {
      showToast('Agendado em 5s! Bloqueie a tela do celular agora!', 'info');
      await triggerTestPushNotification({ delaySeconds: 5 });
      let sec = 5;
      const lbl = document.getElementById('btn-delay-text');
      if (lbl) lbl.textContent = `Disparando em ${sec}s...`;
      delayTimer = setInterval(() => {
        sec--;
        if (sec > 0) {
          if (lbl) lbl.textContent = `Disparando em ${sec}s...`;
        } else {
          clearInterval(delayTimer);
          delayTimer = null;
          if (lbl) lbl.textContent = 'Testar em 5s (Bloqueie a Tela)';
        }
      }, 1000);
    } catch (e) {
      showToast('Erro: ' + e.message, 'error');
    }
  });

}

/* =========================================================
   SINCRONIZAÇÃO CROSS-TAB E REDE WEBRTC P2P
========================================================= */
function initCrossTabSync() {
  listenToBroadcasts(
    () => {
      updateAllMarkers();
      renderMembersList();
      renderPlacesList();
      checkActivePlaces();
    },
    (sosUser) => {
      showToast(`ALERTA SOS de ${sosUser.name}!`, 'sos');
      startSOSAlarm();
      notifySOSAlert(sosUser.name);
    }
  );
}

function initP2P() {
  p2pEngine = initP2PNetwork({
    onPeerConnected: () => {
      showToast('Novo aparelho conectado ao círculo.', 'info');
      playRadarPing();
      renderMembersList();
    },
    onPeerDisconnected: () => {
      renderMembersList();
    },
    onLocationReceived: (remoteUser) => {
      updateMarkerForMember(remoteUser);
      renderMembersList();
      checkActivePlaces();
    },
    onPingUpdated: (peerId, rttMs) => {
      const p2pVal = document.getElementById('p2p-status-val');
      if (p2pVal) p2pVal.textContent = `P2P ${rttMs}ms`;
    },
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          reg.update();
          updateNotificationUI();
        })
        .catch(() => {});
    });
  }
}

// BOOTSTRAP DA APLICAÇÃO
document.addEventListener('DOMContentLoaded', () => {
  initAppState();
  initMap();
  startGeolocationTracking();
  registerServiceWorker();
  updateHeaderProfileUI();
  renderMembersList();
  renderPlacesList();
  setupUIEventListeners();
  initCrossTabSync();
  initP2P();
  updateNotificationUI();
  checkAutoOpenPWAInstall();
});
