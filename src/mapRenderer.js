// GeoPulse - Renderizador e Controlador do Mapa Leaflet
// Otimizado com Marker Diffing (zero DOM thrashing), Smooth Transitions e Camadas HD
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { state } from './sync.js';
import { calculateDistance, formatDistance } from './geo.js';
import { eventBus } from './eventBus.js';

let map = null;
let currentTileLayer = null;
let autoFollowUser = true;
let activeRoutePolyline = null;
let userAccuracyCircle = null;

const markersMap = new Map(); // id -> L.marker
const markerCacheMap = new Map(); // id -> hash/key de propriedades visuais
const placeCirclesMap = new Map();
const placeMarkersMap = new Map();

// Provedores de Tiles 100% Oficiais, Livres de API Key, Rate Limits e Watermarks
export const TILE_LAYERS = {
  dark: L.layerGroup([
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      {
        maxNativeZoom: 16,
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri',
        className: 'esri-dark-tiles-base',
      }
    ),
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      {
        maxNativeZoom: 16,
        maxZoom: 19,
        pane: 'overlayPane',
        className: 'esri-dark-tiles-ref',
      }
    ),
  ]),
  satellite: L.layerGroup([
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxNativeZoom: 18,
        maxZoom: 20,
        attribution: 'Tiles &copy; Esri',
      }
    ),
    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      {
        maxNativeZoom: 18,
        maxZoom: 20,
        pane: 'overlayPane',
      }
    ),
    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      {
        maxNativeZoom: 18,
        maxZoom: 20,
        pane: 'overlayPane',
      }
    ),
  ]),
  streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }),
};

export function getMapInstance() {
  return map;
}

export function isAutoFollowUser() {
  return autoFollowUser;
}

export function setAutoFollowUser(val) {
  autoFollowUser = val;
}

export function initMap() {
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

  map.on('dragstart', () => {
    autoFollowUser = false;
    const recenterBtn = document.getElementById('btn-recenter-floating');
    if (recenterBtn) recenterBtn.classList.remove('active-gps');
  });

  setTimeout(() => map?.invalidateSize(), 150);
  setTimeout(() => map?.invalidateSize(), 600);

  window.addEventListener('resize', () => map?.invalidateSize());
  window.addEventListener('orientationchange', () => {
    setTimeout(() => map?.invalidateSize(), 300);
  });

  renderPlaceOverlays();
  updateAllMarkers();
}

export function switchMapLayer(layerKey) {
  if (!map || !TILE_LAYERS[layerKey]) return;
  if (currentTileLayer) map.removeLayer(currentTileLayer);
  currentTileLayer = TILE_LAYERS[layerKey];
  currentTileLayer.addTo(map);
}

function getMembersInsidePlace(place) {
  const allMembers = [state.currentUser, ...Array.from(state.members.values())];
  const radius = place.radius || 250;
  return allMembers.filter((m) => {
    if (!m.lat || !m.lng) return false;
    return calculateDistance(m.lat, m.lng, place.lat, place.lng) <= radius;
  });
}

function generateMarkerVisualKey(member) {
  const isMe = !!member.isMe;
  const isSOS = !!member.sos;
  const speed = member.speed ? Math.round(member.speed) : 0;
  const heading = member.heading ? Math.round(member.heading) : 0;
  return `${member.id}_${member.name}_${member.color}_${member.photo}_${isMe}_${isSOS}_${speed > 3 ? 'moving' : 'idle'}_${speed > 18 ? 'fast' : 'slow'}_${heading}`;
}

export function createMemberMarkerIcon(member) {
  const isMe = member.isMe;
  const color = member.color || (isMe ? '#007AFF' : '#EC4899');
  const avatarText = member.avatar || member.name.slice(0, 2).toUpperCase();
  const photoUrl = member.photo || '';
  const speed = member.speed ? Math.round(member.speed) : 0;
  const isMoving = speed > 3;
  const isSOS = !!member.sos;

  const heading = typeof member.heading === 'number' && !isNaN(member.heading) ? Math.round(member.heading) : null;
  const showBeam = heading !== null && isMoving;
  const coneHtml = showBeam
    ? `
    <div class="marker-heading-cone" style="transform: rotate(${heading}deg);">
      <svg viewBox="0 0 100 100" class="vision-beam-svg">
        <defs>
          <radialGradient id="beamGrad-${member.id || 'me'}" cx="50%" cy="50%" r="50%">
            <stop offset="20%" stop-color="#007AFF" stop-opacity="0.5"/>
            <stop offset="90%" stop-color="#007AFF" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <path d="M 50 50 L 24 8 A 46 46 0 0 1 76 8 Z" fill="url(#beamGrad-${member.id || 'me'})" />
      </svg>
    </div>
  `
    : '';

  const haloHtml = isMoving ? `<div class="marker-pulse-halo" style="border-color:${color};"></div>` : '';
  const sosHtml = isSOS
    ? `
    <div class="marker-sos-ring ring-1"></div>
    <div class="marker-sos-ring ring-2"></div>
  `
    : '';

  let badgeHtml = '';
  if (isSOS) {
    badgeHtml = `<div class="marker-badge marker-badge-sos">🚨 SOS</div>`;
  } else if (speed > 18) {
    badgeHtml = `<div class="marker-badge marker-badge-speed">🚗 ${speed} km/h</div>`;
  } else if (speed >= 3) {
    badgeHtml = `<div class="marker-badge marker-badge-speed">🚶 ${speed} km/h</div>`;
  }

  const avatarStyle = photoUrl
    ? `background-image: url('${photoUrl}'); background-color: ${color};`
    : `background-color: ${color};`;

  const html = `
    <div class="apple-map-marker ${isMe ? 'is-me' : ''} ${isSOS ? 'is-sos' : ''}">
      ${coneHtml}
      ${sosHtml}
      <div class="marker-pin-avatar" style="${avatarStyle}">
        ${haloHtml}
        ${photoUrl ? '' : avatarText}
      </div>
      ${badgeHtml}
      <div class="marker-label-tag">
        ${member.name}
      </div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'apple-leaflet-marker',
    iconSize: [48, 58],
    iconAnchor: [24, 29],
  });
}

function createPlaceMarkerIcon(place) {
  const occupants = getMembersInsidePlace(place);
  const count = occupants.length;
  const occupantsBadge = count > 0 ? `<div class="place-occupants-badge">${count}</div>` : '';

  const html = `
    <div class="place-map-marker ${count > 0 ? 'has-occupants' : ''}">
      <div class="place-map-icon" style="border-color:${place.color || '#007AFF'};">
        ${place.icon || '📍'}
        ${occupantsBadge}
      </div>
      <div class="marker-label-tag">
        ${place.name}
      </div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'apple-place-marker',
    iconSize: [40, 50],
    iconAnchor: [20, 25],
  });
}

/**
 * Atualiza o marcador com Marker Diffing:
 * Se o HTML do marcador não mudou, apenas atualiza as coordenadas com setLatLng() suave
 */
export function updateMarkerForMember(member) {
  if (!map || !member || !member.lat || !member.lng) return;

  const currentVisualKey = generateMarkerVisualKey(member);
  const cachedVisualKey = markerCacheMap.get(member.id);

  if (markersMap.has(member.id)) {
    const existingMarker = markersMap.get(member.id);
    existingMarker.setLatLng([member.lat, member.lng]);

    // Só refaz o DOM do ícone se a representação visual mudou
    if (cachedVisualKey !== currentVisualKey) {
      existingMarker.setIcon(createMemberMarkerIcon(member));
      markerCacheMap.set(member.id, currentVisualKey);
    }
  } else {
    const marker = L.marker([member.lat, member.lng], {
      icon: createMemberMarkerIcon(member),
    }).addTo(map);

    marker.on('click', () => {
      eventBus.emit('member:selected', member);
    });

    markersMap.set(member.id, marker);
    markerCacheMap.set(member.id, currentVisualKey);
  }
}

export function removeMarker(memberId) {
  if (markersMap.has(memberId) && map) {
    try {
      map.removeLayer(markersMap.get(memberId));
    } catch (e) {}
    markersMap.delete(memberId);
    markerCacheMap.delete(memberId);
  }
}

export function updateAllMarkers() {
  updateMarkerForMember(state.currentUser);
  state.members.forEach((member) => {
    updateMarkerForMember(member);
  });
}

export function updateUserAccuracyCircle(lat, lng, accuracy) {
  if (!map) return;
  const visualRadius = Math.max(15, Math.min(accuracy || 20, 80));

  if (userAccuracyCircle) {
    userAccuracyCircle.setLatLng([lat, lng]);
    userAccuracyCircle.setRadius(visualRadius);
  } else {
    userAccuracyCircle = L.circle([lat, lng], {
      radius: visualRadius,
      color: '#007AFF',
      weight: 1,
      opacity: 0.35,
      fillColor: '#007AFF',
      fillOpacity: 0.05,
      dashArray: '3, 4',
    }).addTo(map);
  }
}

export function renderPlaceOverlays() {
  if (!map) return;

  placeCirclesMap.forEach((circle) => map.removeLayer(circle));
  placeMarkersMap.forEach((marker) => map.removeLayer(marker));
  placeCirclesMap.clear();
  placeMarkersMap.clear();

  state.geofences.forEach((place) => {
    const circle = L.circle([place.lat, place.lng], {
      radius: place.radius || 250,
      color: place.color || '#007AFF',
      weight: 1.5,
      opacity: 0.75,
      fillColor: place.color || '#007AFF',
      fillOpacity: 0.12,
    }).addTo(map);

    const icon = createPlaceMarkerIcon(place);
    const marker = L.marker([place.lat, place.lng], { icon }).addTo(map);
    marker.on('click', () => {
      map.flyTo([place.lat, place.lng], 16, { duration: 0.8 });
      const occupants = getMembersInsidePlace(place);
      const names = occupants.length > 0 ? occupants.map((m) => m.name).join(', ') : 'Nenhum membro no momento';
      const popupHtml = `
        <div class="apple-map-popup">
          <div class="popup-header">
            <span class="popup-icon">${place.icon || '📍'}</span>
            <strong>${place.name}</strong>
          </div>
          <div class="popup-sub">Raio monitorado: ${place.radius || 250} metros</div>
          <div class="popup-occupants">
            <strong>Presentes agora:</strong>
            <p>${names}</p>
          </div>
        </div>
      `;
      marker.bindPopup(popupHtml, { className: 'apple-leaflet-popup', offset: [0, -12] }).openPopup();
    });

    placeCirclesMap.set(place.id, circle);
    placeMarkersMap.set(place.id, marker);
  });
}

export function drawRouteToMember(member) {
  if (!map) return;

  if (activeRoutePolyline) {
    map.removeLayer(activeRoutePolyline);
    activeRoutePolyline = null;
  }

  const startCoords = [state.currentUser.lat, state.currentUser.lng];
  const destCoords = [member.lat, member.lng];

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

export function clearActiveRoute() {
  if (activeRoutePolyline && map) {
    map.removeLayer(activeRoutePolyline);
    activeRoutePolyline = null;
  }
  const banner = document.getElementById('active-route-banner');
  if (banner) banner.style.display = 'none';
  state.activeRoute = null;
}

export function fitAllMembers() {
  if (!map) return;
  const allCoords = [
    [state.currentUser.lat, state.currentUser.lng],
    ...Array.from(state.members.values()).map((m) => [m.lat, m.lng]),
  ];
  map.fitBounds(L.latLngBounds(allCoords), { padding: [60, 60], maxZoom: 16 });
}

export function flyToUser() {
  if (map && state.currentUser.lat && state.currentUser.lng) {
    autoFollowUser = true;
    map.flyTo([state.currentUser.lat, state.currentUser.lng], 16, { duration: 0.8 });
  }
}
