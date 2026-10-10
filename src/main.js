import './style.css';
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
  broadcastUserUpdate,
  listenToBroadcasts,
  addCustomMember,
  removeMember,
  clearAllMembers,
} from './sync.js';
import { checkGeofences } from './geofence.js';
import { generateQRCodeSVG } from './qrcode.js';
import { initP2PNetwork, enableScreenWakeLock } from './p2p.js';

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
let showTrails = true;
let isFirstGpsFix = true;
let activeFocusedMemberId = null;
let locationMode = 'gps'; // 'gps' por padrão para rastreamento ativo em tempo real do celular
let autoFollowUser = true; // Mantém o mapa acompanhando o deslocamento do celular
let p2pEngine = null;
let gpsWatchId = null;
let lastGeocodedAddressCoords = null;
let lastGeocodedAddressTime = 0;

const markersMap = new Map();
const trailsMap = new Map();
const geofencesMap = new Map();
let userAccuracyCircle = null;

// Provedores de Tiles 100% Livres de Watermark e sem exigência de API Key
const TILE_LAYERS = {
  // Modo Minimalista Editorial com Esri Canvas World Light Gray
  minimal: L.layerGroup([
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 16,
        attribution: 'Tiles &copy; Esri',
      }
    ),
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 16,
        attribution: 'Tiles &copy; Esri',
      }
    ),
  ]),
  // Modo Ruas oficial do OpenStreetMap
  streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }),
  // Modo Noturno Tático com Esri Dark Gray
  dark: L.layerGroup([
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 16,
        attribution: 'Tiles &copy; Esri',
      }
    ),
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 16,
        attribution: 'Tiles &copy; Esri',
      }
    ),
  ]),
  // Modo Satélite de alta resolução da Esri
  satellite: L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 18,
      attribution: 'Tiles &copy; Esri',
    }
  ),
};

/* =========================================================
   INICIALIZAÇÃO DO MAPA EM MANAUS
========================================================= */
function initMap() {
  const initialLat = MANAUS_COORDS.lat;
  const initialLng = MANAUS_COORDS.lng;

  state.currentUser.lat = initialLat;
  state.currentUser.lng = initialLng;

  map = L.map('map', {
    center: [initialLat, initialLng],
    zoom: 14,
    zoomControl: false,
    attributionControl: false,
  });

  // Camada padrão: Modo Noturno Tático (Esri Dark Gray - Rio Negro e Vias em Alta Definição)
  currentTileLayer = TILE_LAYERS.dark;
  currentTileLayer.addTo(map);

  // Círculo de precisão de radar ciano de alta visibilidade
  userAccuracyCircle = L.circle([initialLat, initialLng], {
    radius: state.currentUser.accuracy,
    color: '#00F0FF',
    fillColor: '#00F0FF',
    fillOpacity: 0.1,
    weight: 1.5,
    dashArray: '4, 4',
  }).addTo(map);

  // Se estiver em modo manual, clicar no mapa reposiciona
  map.on('click', (e) => {
    if (locationMode === 'manual') {
      updateCurrentUserPosition(e.latlng.lat, e.latlng.lng, 8, 0);
      const hudStatus = document.getElementById('hud-gps-status');
      if (hudStatus) hudStatus.textContent = 'Posição Manual';
      showToast('Marcador posicionado nas coordenadas indicadas.', 'info');
    }
  });

  // Quando o mapa é arrastado manualmente pelo usuário, pausa o acompanhamento suave
  map.on('dragstart', () => {
    if (autoFollowUser) {
      autoFollowUser = false;
      const recenterBtn = document.getElementById('btn-recenter-floating');
      if (recenterBtn) {
        const lbl = document.getElementById('recenter-label');
        if (lbl) lbl.textContent = locationMode === 'gps' ? 'Seguir Meu GPS' : 'Voltar ao GPS';
        recenterBtn.style.display = 'inline-flex';
      }
    }
  });

  // Handler para exclusão de ponto via popup no mapa
  map.on('popupopen', (e) => {
    const el = e.popup.getElement();
    if (el) {
      const deleteBtn = el.querySelector('[data-popup-delete]');
      if (deleteBtn) {
        deleteBtn.onclick = () => {
          const id = deleteBtn.getAttribute('data-popup-delete');
          map.closePopup();
          deleteMemberById(id);
        };
      }
    }
  });

  // Renderiza cercas (inicia vazio se não houver cadastros)
  renderGeofenceOverlays();

  // Renderiza marcador de "Você"
  updateAllMarkers();
}

/* =========================================================
   EXCLUSÃO DE PONTOS / MEMBROS
========================================================= */
function deleteMemberById(id) {
  playTactileClick();

  // Remove marcador do mapa
  const marker = markersMap.get(id);
  if (marker) {
    map.removeLayer(marker);
    markersMap.delete(id);
  }

  // Remove rastro
  const trail = trailsMap.get(id);
  if (trail) {
    map.removeLayer(trail);
    trailsMap.delete(id);
  }

  // Remove do estado
  removeMember(id);

  // Atualiza interface
  updateAllMarkers();
  renderMembersList();
  showToast('Ponto excluído com sucesso.', 'info');
}

function clearAllMembersAction() {
  playTactileClick();

  // Remove todos os marcadores com exceção de "Você"
  markersMap.forEach((marker, id) => {
    if (id !== state.currentUser.id) {
      map.removeLayer(marker);
      markersMap.delete(id);
    }
  });

  // Remove rastros de outros pontos
  trailsMap.forEach((trail, id) => {
    if (id !== state.currentUser.id) {
      map.removeLayer(trail);
      trailsMap.delete(id);
    }
  });

  clearAllMembers();
  updateAllMarkers();
  renderMembersList();
  showToast('Todos os pontos manuais foram excluídos.', 'info');
}

/**
 * Centraliza o mapa e o usuário diretamente em Manaus
 */
export function goToManaus() {
  playTactileClick();
  locationMode = 'manual';
  autoFollowUser = false;
  updateCurrentUserPosition(MANAUS_COORDS.lat, MANAUS_COORDS.lng, 8, 0);
  map.flyTo([MANAUS_COORDS.lat, MANAUS_COORDS.lng], 14, { duration: 1.2 });
  const hudStatus = document.getElementById('hud-gps-status');
  if (hudStatus) hudStatus.textContent = 'Manaus (Manual)';
  showToast('Mapa centralizado em Manaus. Toque no botão de mira para voltar ao GPS ao vivo.', 'info');
  const recenterBtn = document.getElementById('btn-recenter-floating');
  if (recenterBtn) {
    const lbl = document.getElementById('recenter-label');
    if (lbl) lbl.textContent = 'Voltar ao GPS Ao Vivo';
    recenterBtn.style.display = 'inline-flex';
  }
  renderMembersList();
}

/**
 * Força a solicitação de GPS nativo do aparelho
 */
export function forceDeviceGPS() {
  playTactileClick();
  locationMode = 'gps';
  autoFollowUser = true;
  const recenterBtn = document.getElementById('btn-recenter-floating');
  if (recenterBtn) recenterBtn.style.display = 'none';

  const hudGpsStatus = document.getElementById('hud-gps-status');
  const hudDot = document.querySelector('#hud-user-status .hud-dot');
  if (hudGpsStatus) hudGpsStatus.textContent = 'Obtendo GPS...';
  if (hudDot) hudDot.className = 'hud-dot online pulse-live';

  if (!('geolocation' in navigator)) {
    showToast('Dispositivo não suporta API de Geolocalização.', 'info');
    return;
  }

  showToast('Sintonizando satélites GPS do celular...', 'info');

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const banner = document.getElementById('gps-permission-banner');
      if (banner) banner.style.display = 'none';

      const { latitude, longitude, accuracy, speed } = pos.coords;
      const speedKmH = (speed !== null && speed !== undefined && speed > 0) ? speed * 3.6 : 0;

      updateCurrentUserPosition(latitude, longitude, accuracy, speedKmH);
      map.flyTo([latitude, longitude], 16, { duration: 1.2 });
      showToast('GPS ao vivo conectado com sucesso!', 'info');

      reverseGeocode(latitude, longitude).then((addr) => {
        const addrMe = document.getElementById('addr-me');
        if (addrMe) addrMe.textContent = addr;
      });

      renderMembersList();
    },
    (err) => {
      console.warn('GPS error:', err);
      showToast('Permissão de GPS negada ou sem sinal.', 'info');
      const banner = document.getElementById('gps-permission-banner');
      if (banner && err.code === 1) banner.style.display = 'block';
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

/* =========================================================
   RENDERIZAÇÃO DE MARCADORES CUSTOMIZADOS
========================================================= */
function createMarkerIcon(member) {
  const isMe = member.isMe;
  const color = isMe ? '#00F0FF' : (member.color || '#38BDF8');
  const avatar = member.avatar || member.name.substring(0, 2).toUpperCase();
  const speedText = member.speed > 1 ? `${Math.round(member.speed)} km/h` : 'Parado';
  const sosClass = member.sos ? 'sos' : '';
  const meClass = isMe ? 'is-command-center' : '';

  const html = `
    <div class="custom-radar-marker ${meClass} ${sosClass}" style="--marker-color: ${color}">
      ${isMe ? '<div class="marker-radar-sweep"></div><div class="marker-radar-ping"></div><div class="marker-radar-outer-ring"></div>' : ''}
      ${
        member.heading !== undefined
          ? `<div class="marker-heading-cone" style="transform: rotate(${member.heading}deg)"></div>`
          : ''
      }
      <div class="marker-avatar-inner" title="${member.name} (${isMe ? 'Ponto Central VC · Arraste para reposicionar' : speedText})">
        ${member.sos ? '!' : (isMe ? 'VC' : avatar)}
      </div>
      <div class="marker-label-tag">${isMe ? 'VC · COMANDO ATIVO' : `${member.name.split(' ')[0]} · ${speedText}`}</div>
    </div>
  `;

  return L.divIcon({
    html: html,
    className: 'leaflet-div-marker-wrapper',
    iconSize: [52, 52],
    iconAnchor: [26, 26],
  });
}

function updateMarkerForMember(member) {
  let marker = markersMap.get(member.id);

  if (!marker) {
    // Marcador de VOCÊ é ARRASTÁVEL!
    marker = L.marker([member.lat, member.lng], {
      icon: createMarkerIcon(member),
      zIndexOffset: member.isMe ? 1000 : 500,
      draggable: !!member.isMe,
    }).addTo(map);

    // Se for o usuário principal, evento de arrastar e soltar
    if (member.isMe) {
      marker.on('dragend', (e) => {
        const newPos = e.target.getLatLng();
        locationMode = 'manual';
        autoFollowUser = false;
        updateCurrentUserPosition(newPos.lat, newPos.lng, 5, 0);
        const hudStatus = document.getElementById('hud-gps-status');
        if (hudStatus) hudStatus.textContent = 'Posição Ajustada';
        showToast('Modo manual ativado. Toque no botão de mira ou em Seguir para voltar ao GPS ao vivo.', 'info');
        const recenterBtn = document.getElementById('btn-recenter-floating');
        if (recenterBtn) {
          const lbl = document.getElementById('recenter-label');
          if (lbl) lbl.textContent = 'Voltar ao GPS Ao Vivo';
          recenterBtn.style.display = 'inline-flex';
        }
        renderMembersList();
      });
    }

    marker.on('click', () => {
      focusMember(member.id);
    });

    // Se for ponto manual, anexa popup com opção de exclusão
    if (!member.isMe) {
      marker.bindPopup(`
        <div class="marker-popup-card">
          <strong style="color:var(--text-main); font-size:13px;">${member.name}</strong>
          <div style="font-size:11px; color:var(--text-muted); margin: 4px 0 8px;">${member.role || 'Ponto Manual'}</div>
          <button class="btn-popup-delete" data-popup-delete="${member.id}">Excluir Ponto</button>
        </div>
      `);
    }

    markersMap.set(member.id, marker);
  } else {
    marker.setLatLng([member.lat, member.lng]);
    marker.setIcon(createMarkerIcon(member));
  }

  // Atualiza rastro de deslocamento (trail polyline)
  if (showTrails && member.history && member.history.length > 1) {
    let trail = trailsMap.get(member.id);
    const latlngs = member.history.map((h) => [h.lat, h.lng]);

    if (!trail) {
      trail = L.polyline(latlngs, {
        color: member.color || (member.isMe ? '#00F0FF' : '#38BDF8'),
        weight: 2.5,
        opacity: 0.8,
        dashArray: '3, 6',
        lineCap: 'round',
      }).addTo(map);
      trailsMap.set(member.id, trail);
    } else {
      trail.setLatLngs(latlngs);
    }
  }
}

function updateAllMarkers() {
  // Limpa marcadores de membros removidos
  const activeIds = new Set([state.currentUser.id, ...state.members.keys()]);
  markersMap.forEach((marker, id) => {
    if (!activeIds.has(id)) {
      map.removeLayer(marker);
      markersMap.delete(id);
    }
  });

  // Atualiza marcador de "Você"
  updateMarkerForMember(state.currentUser);

  // Atualiza círculo de precisão
  if (userAccuracyCircle) {
    userAccuracyCircle.setLatLng([state.currentUser.lat, state.currentUser.lng]);
    userAccuracyCircle.setRadius(state.currentUser.accuracy || 10);
  }

  // Atualiza membros reais conectados
  state.members.forEach((member) => {
    updateMarkerForMember(member);
  });
}

/* =========================================================
   CERCAS VIRTUAIS (GEOFENCES) NO MAPA
========================================================= */
function renderGeofenceOverlays() {
  geofencesMap.forEach((circle) => map.removeLayer(circle));
  geofencesMap.clear();

  state.geofences.forEach((fence) => {
    const circle = L.circle([fence.lat, fence.lng], {
      radius: fence.radius,
      color: fence.color,
      fillColor: fence.color,
      fillOpacity: 0.12,
      weight: 2,
      dashArray: '6, 6',
    }).addTo(map);

    circle.bindTooltip(`${fence.name} (${fence.radius}m)`, {
      permanent: false,
      direction: 'top',
      className: 'fence-tooltip',
    });

    geofencesMap.set(fence.id, circle);
  });

  renderGeofencesSidebarList();
}

function renderGeofencesSidebarList() {
  const container = document.getElementById('geofences-list');
  if (!container) return;

  if (state.geofences.length === 0) {
    container.innerHTML = `
      <div class="empty-state-box">
        <p>Nenhuma cerca virtual cadastrada.</p>
        <button class="btn-text-action" id="btn-create-first-fence">+ Criar Área Segura</button>
      </div>
    `;
    document.getElementById('btn-create-first-fence')?.addEventListener('click', () => {
      openFenceModal();
    });
    return;
  }

  container.innerHTML = state.geofences
    .map(
      (f) => `
    <div class="geofence-chip" data-fence-id="${f.id}">
      <div class="fence-left">
        <span class="fence-color-dot" style="background: ${f.color}"></span>
        <strong>${f.name}</strong>
      </div>
      <div class="fence-right">
        <span class="fence-radius-tag">${f.radius}m</span>
        <button class="btn-delete-fence" data-delete-id="${f.id}" title="Remover Cerca">&times;</button>
      </div>
    </div>
  `
    )
    .join('');

  container.querySelectorAll('.geofence-chip').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-delete-fence')) return;
      const fenceId = el.getAttribute('data-fence-id');
      const fence = state.geofences.find((f) => f.id === fenceId);
      if (fence) {
        map.flyTo([fence.lat, fence.lng], 16, { duration: 1 });
        playTactileClick();
      }
    });
  });

  container.querySelectorAll('.btn-delete-fence').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-delete-id');
      state.geofences = state.geofences.filter((f) => f.id !== id);
      renderGeofenceOverlays();
      showToast('Cerca virtual removida', 'info');
    });
  });
}

/* =========================================================
   SIDEBAR & LISTA DE MEMBROS
========================================================= */
async function renderMembersList() {
  const container = document.getElementById('members-list');
  if (!container) return;

  const otherMembers = Array.from(state.members.values());
  const allMembers = [state.currentUser, ...otherMembers];

  // Controla o botão "Limpar Pontos" no topo da sidebar
  const btnClearAll = document.getElementById('btn-clear-all-members');
  if (btnClearAll) {
    btnClearAll.style.display = otherMembers.length > 0 ? 'inline-block' : 'none';
    btnClearAll.onclick = (e) => {
      e.stopPropagation();
      clearAllMembersAction();
    };
  }

  // Renderiza cartão de "Você"
  const isFocusedMe = activeFocusedMemberId === state.currentUser.id ? 'focused' : '';
  const mySpeedText = state.currentUser.speed > 1 ? `${Math.round(state.currentUser.speed)} km/h` : 'Parado';
  const roleText = locationMode === 'gps'
    ? 'GPS Ao Vivo · Telemetria em Tempo Real'
    : 'Modo Manual · Posição Ajustada';

  let html = `
    <div class="member-card member-card-shell ${isFocusedMe}" data-member-id="${state.currentUser.id}" style="--member-color: ${state.currentUser.color}">
      <div class="member-card-core">
        <div class="member-card-top">
          <div class="member-info-left">
            <div class="member-avatar" style="--member-color: ${state.currentUser.color}">
              ${state.currentUser.avatar}
              <span class="online-indicator"></span>
            </div>
            <div class="member-names">
              <div class="member-name-row">
                <span class="member-name">${state.currentUser.name}</span>
                <span class="me-badge">VOCÊ</span>
                ${locationMode === 'gps' ? '<span class="live-tag-mini">AO VIVO</span>' : ''}
              </div>
              <span class="member-role">${roleText}</span>
            </div>
          </div>
          <div class="member-status-right">
            <span class="speed-badge ${state.currentUser.speed > 1 ? 'moving' : ''}">
              ${mySpeedText}
            </span>
            <span class="battery-badge">
              ${state.currentUser.battery}%
            </span>
          </div>
        </div>
        <div class="member-card-bottom">
          <span class="member-address" id="addr-me">Obtendo endereço...</span>
          <span class="member-dist">${locationMode === 'gps' ? `Precisão ±${Math.round(state.currentUser.accuracy || 10)}m` : 'Seu Dispositivo'}</span>
        </div>
      </div>
    </div>
  `;

  // Se houver outros membros, renderiza com botão individual de exclusão
  if (otherMembers.length > 0) {
    for (const m of otherMembers) {
      const distToMe = calculateDistance(
        state.currentUser.lat,
        state.currentUser.lng,
        m.lat,
        m.lng
      );
      const isFocused = activeFocusedMemberId === m.id ? 'focused' : '';
      const speedStr = m.speed > 1 ? `${Math.round(m.speed)} km/h` : 'Parado';

      html += `
        <div class="member-card member-card-shell ${isFocused}" data-member-id="${m.id}" style="--member-color: ${m.color}">
          <div class="member-card-core">
            <div class="member-card-top">
              <div class="member-info-left">
                <div class="member-avatar" style="--member-color: ${m.color}">
                  ${m.avatar}
                  <span class="online-indicator"></span>
                </div>
                <div class="member-names">
                  <div class="member-name-row">
                    <span class="member-name">${m.name}</span>
                  </div>
                  <span class="member-role">${m.role || 'Ponto Manual'}</span>
                </div>
              </div>
              <div class="member-actions-right">
                <div class="member-status-badges">
                  <span class="speed-badge ${m.speed > 1 ? 'moving' : ''}">${speedStr}</span>
                  <span class="battery-badge">${m.battery}%</span>
                </div>
                <button class="btn-delete-member" data-delete-id="${m.id}" title="Excluir este ponto">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="delete-icon">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>
                </button>
              </div>
            </div>
            <div class="member-card-bottom">
              <span class="member-address" id="addr-${m.id.replace(/[^a-zA-Z0-9]/g, '_')}">Obtendo endereço...</span>
              <span class="member-dist">${formatDistance(distToMe)} de você</span>
            </div>
          </div>
        </div>
      `;
    }
  } else {
    // Estado limpo amigável quando apenas você está no círculo
    html += `
      <div class="empty-state-members">
        <div class="empty-radar-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="28" height="28">
            <circle cx="12" cy="12" r="9"></circle>
            <path d="M12 3a9 9 0 0 1 9 9"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </div>
        <h4>Nenhum outro membro no radar</h4>
        <p>Compartilhe o link do círculo ou use a barra de busca para encontrar qualquer local.</p>
        <button class="btn btn-secondary btn-sm" id="btn-quick-invite">
          <span>+ Convidar Pessoas</span>
        </button>
      </div>
    `;
  }

  container.innerHTML = html;

  // Botão de convite rápido dentro do estado vazio
  document.getElementById('btn-quick-invite')?.addEventListener('click', () => {
    openShareModal();
  });

  // Associa cliques para excluir ponto
  container.querySelectorAll('.btn-delete-member').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-delete-id');
      deleteMemberById(id);
    });
  });

  // Associa cliques para focar no mapa
  container.querySelectorAll('.member-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete-member')) return;
      const id = card.getAttribute('data-member-id');
      focusMember(id);
    });
  });

  // Atualiza endereços via geocodificação reversa
  const addrMe = document.getElementById('addr-me');
  if (addrMe) {
    reverseGeocode(state.currentUser.lat, state.currentUser.lng).then((addr) => {
      addrMe.textContent = addr;
    });
  }

  otherMembers.forEach(async (m) => {
    const addrEl = document.getElementById(`addr-${m.id.replace(/[^a-zA-Z0-9]/g, '_')}`);
    if (addrEl) {
      const addr = await reverseGeocode(m.lat, m.lng);
      addrEl.textContent = addr;
    }
  });

  // Atualiza contagem no header
  const countEl = document.getElementById('header-member-count');
  if (countEl) countEl.textContent = allMembers.length;
}

function focusMember(memberId) {
  playTactileClick();
  activeFocusedMemberId = memberId;

  const target =
    memberId === state.currentUser.id ? state.currentUser : state.members.get(memberId);

  if (target) {
    map.flyTo([target.lat, target.lng], 15, {
      duration: 1.2,
      easeLinearity: 0.25,
    });
    playRadarPing();
  }

  // Atualiza classe focused nos cards
  document.querySelectorAll('.member-card').forEach((card) => {
    card.classList.toggle('focused', card.getAttribute('data-member-id') === memberId);
  });
}

/* =========================================================
/* =========================================================
   GEOLOCALIZAÇÃO DO USUÁRIO EM TEMPO REAL (GPS DO CELULAR)
========================================================= */
function throttledReverseGeocode(lat, lng) {
  const now = Date.now();
  if (lastGeocodedAddressCoords) {
    const dist = calculateDistance(lastGeocodedAddressCoords.lat, lastGeocodedAddressCoords.lng, lat, lng);
    // Se moveu menos de 25 metros e faz menos de 20 segundos, evita flood no Nominatim
    if (dist < 25 && now - lastGeocodedAddressTime < 20000) {
      return;
    }
  }

  lastGeocodedAddressCoords = { lat, lng };
  lastGeocodedAddressTime = now;

  reverseGeocode(lat, lng).then((addr) => {
    const addrMe = document.getElementById('addr-me');
    if (addrMe) addrMe.textContent = addr;
  });
}

function updateCurrentUserPosition(lat, lng, accuracy = 10, speed = 0) {
  state.currentUser.lat = lat;
  state.currentUser.lng = lng;
  state.currentUser.accuracy = accuracy;
  state.currentUser.speed = speed;
  state.currentUser.updatedAt = Date.now();

  if (!state.currentUser.history) state.currentUser.history = [];
  const lastH = state.currentUser.history[state.currentUser.history.length - 1];
  if (!lastH || calculateDistance(lastH.lat, lastH.lng, lat, lng) > 2.5) {
    state.currentUser.history.push({ lat, lng, time: Date.now() });
    if (state.currentUser.history.length > 50) state.currentUser.history.shift();
  }

  // Atualiza HUD
  const speedEl = document.getElementById('hud-speed');
  const accEl = document.getElementById('hud-accuracy');
  if (speedEl) speedEl.textContent = `${Math.round(speed)} km/h`;
  if (accEl) accEl.textContent = `±${Math.round(accuracy)} m`;

  // Atualiza marcadores e transmite para outras abas locais
  updateAllMarkers();
  broadcastUserUpdate(state.currentUser);

  // Transmite para celular/PC remoto conectado via WebRTC P2P na rua
  if (p2pEngine) {
    p2pEngine.broadcastPosition(state.currentUser);
  }
}

function startGeolocationTracking() {
  const hudGpsStatus = document.getElementById('hud-gps-status');
  const hudDot = document.querySelector('#hud-user-status .hud-dot');
  const gpsBanner = document.getElementById('gps-permission-banner');

  if (!('geolocation' in navigator)) {
    if (hudGpsStatus) hudGpsStatus.textContent = 'Sem GPS';
    if (hudDot) hudDot.className = 'hud-dot error';
    return;
  }

  // Ativa Screen Wake Lock para o celular não desligar a tela durante o rastreamento
  enableScreenWakeLock();

  if (hudGpsStatus) hudGpsStatus.textContent = 'Localizando GPS...';
  if (hudDot) hudDot.className = 'hud-dot online pulse-live';

  const onSuccess = (pos) => {
    // Esconde banner caso a permissão tenha sido concedida
    if (gpsBanner) gpsBanner.style.display = 'none';

    // Se o usuário alternou explicitamente para manual via arrasto, respeitamos até clique em recentralizar
    if (locationMode === 'manual') {
      return;
    }

    const { latitude, longitude, accuracy, speed, heading } = pos.coords;
    const speedKmH = (speed !== null && speed !== undefined && speed > 0) ? speed * 3.6 : 0;

    if (hudGpsStatus) {
      hudGpsStatus.innerHTML = `<span class="live-tag-mini">AO VIVO</span> ${accuracy < 25 ? 'Alta Precisão' : 'GPS Ativo'}`;
    }
    if (hudDot) hudDot.className = 'hud-dot online pulse-live';

    // Rumo/Direção vinda do GPS
    if (heading !== null && heading !== undefined && !isNaN(heading)) {
      state.currentUser.heading = heading;
    }

    updateCurrentUserPosition(latitude, longitude, accuracy, speedKmH);

    // No primeiro sinal de GPS recebido: centraliza com zoom suave na localização real do celular!
    if (isFirstGpsFix) {
      isFirstGpsFix = false;
      map.flyTo([latitude, longitude], 16, { duration: 1.2 });
      showToast('GPS ao vivo conectado! Rastreando seu celular.', 'info');

      // Força geocodificação inicial imediata
      reverseGeocode(latitude, longitude).then((addr) => {
        const addrMe = document.getElementById('addr-me');
        if (addrMe) addrMe.textContent = addr;
      });
      lastGeocodedAddressCoords = { lat: latitude, lng: longitude };
      lastGeocodedAddressTime = Date.now();
    } else if (autoFollowUser) {
      // Acompanhamento suave no celular
      map.panTo([latitude, longitude], { animate: true, duration: 0.6 });
    }

    throttledReverseGeocode(latitude, longitude);
    renderMembersList();
    checkActiveGeofences();
  };

  const onError = (err) => {
    console.warn('Geolocation info:', err.code, err.message);
    if (err.code === 1) { // PERMISSION_DENIED
      if (hudGpsStatus) hudGpsStatus.textContent = 'Permissão Negada';
      if (hudDot) hudDot.className = 'hud-dot error';
      if (gpsBanner) gpsBanner.style.display = 'block';
      showToast('Permita a localização no celular para atualizar em tempo real.', 'sos');
    } else if (err.code === 2) { // POSITION_UNAVAILABLE
      if (hudGpsStatus) hudGpsStatus.textContent = 'Buscando Satélite...';
      if (hudDot) hudDot.className = 'hud-dot warning';
    } else if (err.code === 3) { // TIMEOUT
      if (hudGpsStatus) hudGpsStatus.textContent = 'Reconectando GPS...';
      if (hudDot) hudDot.className = 'hud-dot warning';
    }
  };

  const geoOptions = {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0,
  };

  // 1. Fix imediato via getCurrentPosition
  navigator.geolocation.getCurrentPosition(onSuccess, onError, geoOptions);

  // 2. Monitoramento contínuo em tempo real via watchPosition
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
  }
  gpsWatchId = navigator.geolocation.watchPosition(onSuccess, onError, geoOptions);

  // 3. Heartbeat a cada 6s (impede que browsers mobile silenciem o GPS em repouso)
  setInterval(() => {
    if (locationMode === 'gps') {
      navigator.geolocation.getCurrentPosition(
        (pos) => onSuccess(pos),
        () => {},
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    }
  }, 6000);

  // 4. Bússola Digital do Aparelho (orienta o pino no mapa em tempo real)
  if (window.DeviceOrientationEvent) {
    window.addEventListener(
      'deviceorientation',
      (e) => {
        if (!state.currentUser.speed || state.currentUser.speed < 2) {
          let heading = null;
          if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
            heading = e.webkitCompassHeading;
          } else if (e.alpha !== null && e.alpha !== undefined) {
            heading = (360 - e.alpha) % 360;
          }
          if (heading !== null) {
            state.currentUser.heading = heading;
            updateAllMarkers();
          }
        }
      },
      { passive: true }
    );
  }

  // 5. Atualiza status da bateria real
  getDeviceBattery().then((bat) => {
    state.currentUser.battery = bat.level;
    state.currentUser.charging = bat.charging;
    const batEl = document.getElementById('hud-battery');
    if (batEl) batEl.textContent = `${bat.level}%`;
  });
}

/* =========================================================
   CHECA CERCAS VIRTUAIS QUANDO HOUVER MOVIMENTAÇÃO
========================================================= */
function checkActiveGeofences() {
  if (state.geofences.length === 0) return;
  const allMembers = [state.currentUser, ...Array.from(state.members.values())];
  checkGeofences(state.geofences, allMembers, (event) => {
    const action = event.type === 'ENTERED' ? 'entrou na área' : 'saiu da área';
    showToast(`${event.memberName} ${action} ${event.fenceName}.`, 'geofence');
  });
}

/* =========================================================
   TOAST DE NOTIFICAÇÕES
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
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
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
    showToast('ALERTA SOS ATIVADO! Transmitindo sinal de emergência.', 'sos');
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
   MODAL DE COMPARTILHAMENTO
========================================================= */
function openShareModal() {
  playTactileClick();
  const modalShare = document.getElementById('modal-share');
  const shareLinkInput = document.getElementById('share-link-input');
  const qrContainer = document.getElementById('qr-container');

  const peerParam = p2pEngine ? `&peer=${p2pEngine.getMyPeerId()}` : '';
  const inviteUrl = `${window.location.origin}${window.location.pathname}?circle=${state.circleId}${peerParam}`;
  if (shareLinkInput) shareLinkInput.value = inviteUrl;
  if (qrContainer) qrContainer.innerHTML = generateQRCodeSVG(inviteUrl);
  if (modalShare) modalShare.style.display = 'flex';
}

function openFenceModal() {
  playTactileClick();
  const modalFence = document.getElementById('modal-fence');
  if (modalFence) modalFence.style.display = 'flex';
}

/* =========================================================
   CONTROLES E EVENTOS DA UI
========================================================= */
function setupUIEventListeners() {
  // Alternar Camadas do Mapa
  const btnMinimal = document.getElementById('btn-layer-minimal');
  const btnDark = document.getElementById('btn-layer-dark');
  const btnStreets = document.getElementById('btn-layer-streets');
  const btnSat = document.getElementById('btn-layer-satellite');

  const switchLayer = (layer, activeBtn) => {
    playTactileClick();
    if (currentTileLayer) map.removeLayer(currentTileLayer);
    currentTileLayer = layer;
    currentTileLayer.addTo(map);

    [btnMinimal, btnDark, btnStreets, btnSat].forEach((b) => b?.classList.remove('active'));
    activeBtn?.classList.add('active');
  };

  btnMinimal?.addEventListener('click', () => switchLayer(TILE_LAYERS.minimal, btnMinimal));
  btnDark?.addEventListener('click', () => switchLayer(TILE_LAYERS.dark, btnDark));
  btnStreets?.addEventListener('click', () => switchLayer(TILE_LAYERS.streets, btnStreets));
  btnSat?.addEventListener('click', () => switchLayer(TILE_LAYERS.satellite, btnSat));

  // Botão Centralizar em Manaus
  document.getElementById('btn-goto-manaus')?.addEventListener('click', goToManaus);

  // Botão Forçar GPS do Aparelho
  document.getElementById('btn-force-gps')?.addEventListener('click', forceDeviceGPS);

  // Centralizar em Mim / Voltar ao GPS Ao Vivo
  document.getElementById('btn-center-me')?.addEventListener('click', () => {
    playTactileClick();
    locationMode = 'gps';
    autoFollowUser = true;
    const recenterBtn = document.getElementById('btn-recenter-floating');
    if (recenterBtn) recenterBtn.style.display = 'none';
    map.flyTo([state.currentUser.lat, state.currentUser.lng], 16, { duration: 1 });
    showToast('Seguindo seu celular em tempo real.', 'info');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        updateCurrentUserPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.speed ? pos.coords.speed * 3.6 : 0);
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });

  // Botão Flutuante de Recentralizar / Seguir GPS (Mobile / Desktop)
  const btnRecenterFloating = document.getElementById('btn-recenter-floating');
  btnRecenterFloating?.addEventListener('click', () => {
    playTactileClick();
    locationMode = 'gps';
    autoFollowUser = true;
    btnRecenterFloating.style.display = 'none';
    map.flyTo([state.currentUser.lat, state.currentUser.lng], 16, { duration: 1 });
    showToast('Seguindo seu celular em tempo real.', 'info');
  });

  // Botão Banner Ativar GPS
  document.getElementById('btn-request-gps-banner')?.addEventListener('click', () => {
    forceDeviceGPS();
  });

  // Enquadrar Todos
  document.getElementById('btn-fit-all')?.addEventListener('click', () => {
    playTactileClick();
    const allCoords = [
      [state.currentUser.lat, state.currentUser.lng],
      ...Array.from(state.members.values()).map((m) => [m.lat, m.lng]),
    ];
    map.fitBounds(L.latLngBounds(allCoords), { padding: [60, 60], maxZoom: 16 });
  });

  // Alternar Rastros
  const btnTrails = document.getElementById('btn-toggle-trails');
  btnTrails?.addEventListener('click', () => {
    playTactileClick();
    showTrails = !showTrails;
    btnTrails.classList.toggle('active', showTrails);

    trailsMap.forEach((polyline) => {
      if (showTrails) {
        polyline.addTo(map);
      } else {
        map.removeLayer(polyline);
      }
    });

    showToast(showTrails ? 'Rastros ativados' : 'Rastros ocultos', 'info');
  });

  // Botão Adicionar Marcador / Ponto Personalizado
  const btnAddCustom = document.getElementById('btn-add-marker-custom');
  btnAddCustom?.addEventListener('click', () => {
    playTactileClick();
    const center = map.getCenter();
    const name = prompt('Digite o nome do novo ponto/membro:') || 'Novo Ponto';
    addCustomMember(name, 'Ponto Manual', center.lat, center.lng);
    updateAllMarkers();
    renderMembersList();
    showToast(`Ponto "${name}" adicionado no centro do mapa.`, 'info');
  });

  // ==========================================
  // BARRA DE BUSCA DE ENDEREÇO / BAIRRO / RUA
  // ==========================================
  const searchInput = document.getElementById('map-search-input');
  const searchClear = document.getElementById('btn-search-clear');
  const searchDropdown = document.getElementById('search-dropdown');
  let searchDebounceTimer = null;

  searchInput?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (searchClear) searchClear.style.display = val ? 'block' : 'none';

    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

    if (val.length < 2) {
      if (searchDropdown) {
        searchDropdown.style.display = 'none';
        searchDropdown.innerHTML = '';
      }
      return;
    }

    searchDebounceTimer = setTimeout(async () => {
      // Se não especificou cidade, tenta priorizar Manaus
      const queryWithCity = val.toLowerCase().includes('manaus') ? val : `${val}, Manaus`;
      let results = await searchAddress(queryWithCity);

      // Fallback para a busca pura caso não ache na cidade
      if (results.length === 0) {
        results = await searchAddress(val);
      }

      if (results.length === 0) {
        searchDropdown.innerHTML = `
          <div style="padding: 10px 14px; font-size: 12px; color: #787774;">
            Nenhum endereço encontrado para "${val}".
          </div>
        `;
        searchDropdown.style.display = 'flex';
        return;
      }

      searchDropdown.innerHTML = results
        .map(
          (item) => `
        <div class="search-result-item" data-lat="${item.lat}" data-lon="${item.lon}">
          <strong>${item.name || item.display_name.split(',')[0]}</strong>
          <span>${item.display_name}</span>
        </div>
      `
        )
        .join('');

      searchDropdown.style.display = 'flex';

      searchDropdown.querySelectorAll('.search-result-item').forEach((itemEl) => {
        itemEl.addEventListener('click', () => {
          const lat = parseFloat(itemEl.getAttribute('data-lat'));
          const lon = parseFloat(itemEl.getAttribute('data-lon'));
          locationMode = 'manual';

          updateCurrentUserPosition(lat, lon, 5, 0);
          map.flyTo([lat, lon], 16, { duration: 1.2 });

          const hudStatus = document.getElementById('hud-gps-status');
          if (hudStatus) hudStatus.textContent = 'Endereço Definido';

          searchDropdown.style.display = 'none';
          searchInput.value = itemEl.querySelector('strong')?.textContent || '';
          showToast('Posicionado no endereço selecionado.', 'info');
          playRadarPing();
        });
      });
    }, 350);
  });

  searchClear?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    searchClear.style.display = 'none';
    if (searchDropdown) {
      searchDropdown.style.display = 'none';
      searchDropdown.innerHTML = '';
    }
  });

  // Fecha dropdown ao clicar fora
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#map-search-box')) {
      if (searchDropdown) searchDropdown.style.display = 'none';
    }
  });

  // Botão SOS
  document.getElementById('btn-sos')?.addEventListener('click', () => {
    triggerSOS();
  });

  document.getElementById('btn-dismiss-sos')?.addEventListener('click', () => {
    triggerSOS();
  });

  // Modal Compartilhar Círculo
  const modalShare = document.getElementById('modal-share');
  const btnOpenShare = document.getElementById('btn-share-circle');
  const btnCloseShare = document.getElementById('btn-close-share-modal');
  const shareLinkInput = document.getElementById('share-link-input');

  btnOpenShare?.addEventListener('click', openShareModal);
  document.getElementById('btn-circle-info')?.addEventListener('click', openShareModal);
  btnCloseShare?.addEventListener('click', () => {
    playTactileClick();
    if (modalShare) modalShare.style.display = 'none';
  });

  // Copiar Código e Link
  document.getElementById('btn-copy-code')?.addEventListener('click', () => {
    playTactileClick();
    navigator.clipboard.writeText(state.circleId);
    showToast('Código copiado!', 'info');
  });

  document.getElementById('btn-copy-link')?.addEventListener('click', () => {
    playTactileClick();
    if (shareLinkInput) {
      navigator.clipboard.writeText(shareLinkInput.value);
      showToast('Link do círculo copiado!', 'info');
    }
  });

  // Modal Nova Cerca Virtual
  const modalFence = document.getElementById('modal-fence');
  const btnOpenFence = document.getElementById('btn-open-fence-modal');
  const btnQuickFence = document.getElementById('btn-add-fence-quick');
  const btnCloseFence = document.getElementById('btn-close-fence-modal');
  const btnCancelFence = document.getElementById('btn-cancel-fence');
  const btnSaveFence = document.getElementById('btn-save-fence');
  const sliderRadius = document.getElementById('fence-radius-slider');
  const labelRadius = document.getElementById('fence-radius-val');

  sliderRadius?.addEventListener('input', (e) => {
    if (labelRadius) labelRadius.textContent = `${e.target.value}m`;
  });

  let selectedFenceColor = '#1F6C9F';
  document.querySelectorAll('.color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      selectedFenceColor = dot.getAttribute('data-color') || '#1F6C9F';
    });
  });

  btnOpenFence?.addEventListener('click', openFenceModal);
  btnQuickFence?.addEventListener('click', openFenceModal);

  const closeFenceModal = () => {
    playTactileClick();
    if (modalFence) modalFence.style.display = 'none';
  };

  btnCloseFence?.addEventListener('click', closeFenceModal);
  btnCancelFence?.addEventListener('click', closeFenceModal);

  btnSaveFence?.addEventListener('click', () => {
    playTactileClick();
    const nameInput = document.getElementById('fence-name-input');
    const name = nameInput?.value.trim() || 'Nova Área Segura';
    const radius = parseInt(sliderRadius?.value || '350', 10);
    const center = map.getCenter();

    const newFence = {
      id: `fence_${Date.now()}`,
      name: name,
      lat: center.lat,
      lng: center.lng,
      radius: radius,
      color: selectedFenceColor,
    };

    state.geofences.push(newFence);
    renderGeofenceOverlays();
    closeFenceModal();
    showToast(`Cerca virtual "${name}" criada com sucesso.`, 'geofence');
  });

  // Mobile Bottom Sheet Drag & Toggle
  const sidebar = document.getElementById('sidebar');
  const sheetHandle = document.getElementById('sheet-handle');
  const sheetToggle = document.getElementById('btn-sheet-toggle');

  const toggleSheet = () => {
    sidebar?.classList.toggle('collapsed');
    const isCollapsed = sidebar?.classList.contains('collapsed');
    playTactileClick();

    const recenterBtn = document.getElementById('btn-recenter-floating');
    if (recenterBtn && recenterBtn.style.display !== 'none') {
      recenterBtn.style.bottom = isCollapsed ? '64px' : '44%';
    }
  };

  sheetHandle?.addEventListener('click', toggleSheet);
  sheetToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSheet();
  });

  // Suporte a swipe por toque no mobile (deslizar para baixo recolhe, para cima expande)
  let touchStartY = 0;
  sidebar?.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  sidebar?.addEventListener('touchend', (e) => {
    const touchEndY = e.changedTouches[0].clientY;
    const diff = touchEndY - touchStartY;
    if (diff > 45 && !sidebar.classList.contains('collapsed')) {
      sidebar.classList.add('collapsed');
      playTactileClick();
    } else if (diff < -45 && sidebar.classList.contains('collapsed')) {
      sidebar.classList.remove('collapsed');
      playTactileClick();
    }
  }, { passive: true });
}

/* =========================================================
   SINCRONIZAÇÃO CROSS-TAB E INICIALIZAÇÃO
========================================================= */
function initCrossTabSync() {
  listenToBroadcasts(
    (memberId) => {
      updateAllMarkers();
      renderMembersList();
      checkActiveGeofences();
    },
    (sosUser) => {
      showToast(`ALERTA SOS recebido de ${sosUser.name}!`, 'sos');
      startSOSAlarm();
    }
  );
}

/* =========================================================
   REDE WEBRTC P2P (CELULAR NA RUA <-> COMPUTADOR EM CASA)
========================================================= */
function initP2P() {
  p2pEngine = initP2PNetwork({
    onPeerConnected: (peerId) => {
      showToast('Dispositivo conectado ao círculo P2P.', 'info');
      playRadarPing();
      updateP2PHUD();
      renderMembersList();
    },
    onPeerDisconnected: (peerId) => {
      showToast('Conexão P2P com dispositivo oscilou. Reconectando...', 'info');
      updateP2PHUD();
      renderMembersList();
    },
    onLocationReceived: (remoteUser) => {
      updateMarkerForMember(remoteUser);
      renderMembersList();
      checkActiveGeofences();
    },
    onPingUpdated: (peerId, rttMs) => {
      const p2pVal = document.getElementById('p2p-status-val');
      if (p2pVal) p2pVal.textContent = `P2P ${rttMs}ms`;
    },
  });
}

function updateP2PHUD() {
  const dot = document.getElementById('p2p-dot');
  const val = document.getElementById('p2p-status-val');
  const count = p2pEngine ? p2pEngine.getConnectionCount() : 0;
  if (count > 0) {
    if (dot) dot.className = 'hud-dot online';
    if (val) val.textContent = `${count} Online`;
  } else {
    if (dot) dot.className = 'hud-dot';
    if (val) val.textContent = 'Aguardando';
  }
}

// BOOTSTRAP DA APLICAÇÃO
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  startGeolocationTracking();
  renderMembersList();
  renderGeofencesSidebarList();
  setupUIEventListeners();
  initCrossTabSync();
  initP2P();
});
