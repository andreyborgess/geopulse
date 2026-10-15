// GeoPulse - Rastreador GPS Adaptativo, Filtro de Jitter e Telemetria em Tempo Real
import { state, broadcastUserUpdate } from './sync.js';
import { broadcastLocation } from './realtime.js';
import { reverseGeocode, calculateDistance } from './geo.js';
import { startBackgroundHeartbeat, startKeepAlive } from './keepalive.js';
import { updateUserAccuracyCircle, isAutoFollowUser, getMapInstance, updateUserHeadingCone } from './mapRenderer.js';
import { eventBus } from './eventBus.js';

let gpsWatchId = null;
let lastBroadcastTime = 0;
let lastGeocodedCoords = null;
let lastGeocodedTime = 0;
let previousPosition = null;

/**
 * Filtro de Jitter para evitar saltos artificiais de GPS quando o usuário está parado
 */
function isPositionJitter(newLat, newLng, accuracy) {
  if (!previousPosition) return false;
  const dist = calculateDistance(previousPosition.lat, previousPosition.lng, newLat, newLng);

  // Se o deslocamento for menor que 8 metros e a imprecisão for alta (> 25m), é ruído do satélite
  if (dist < 8 && accuracy > 25) {
    return true;
  }
  return false;
}

/**
 * Atualiza o estado do usuário com nova telemetria e transmite adaptativamente
 */
export function updateCurrentUserPosition(lat, lng, accuracy = 10, speedKmH = 0, heading = null) {
  if (isPositionJitter(lat, lng, accuracy)) {
    return;
  }

  previousPosition = { lat, lng };
  state.currentUser.lat = lat;
  state.currentUser.lng = lng;
  state.currentUser.accuracy = Math.round(accuracy);
  state.currentUser.speed = Math.round(speedKmH);
  state.currentUser.updatedAt = Date.now();
  state.currentUser.version = (state.currentUser.version || 1) + 1;

  if (heading !== null && heading !== undefined) {
    state.currentUser.heading = Math.round(heading);
  }

  // Atividade Inteligente baseada em telemetria real
  if (speedKmH > 20) {
    state.currentUser.activity = `🚗 Dirigindo · ${Math.round(speedKmH)} km/h`;
  } else if (speedKmH > 3) {
    state.currentUser.activity = `🚶 Caminhando · ${Math.round(speedKmH)} km/h`;
  } else {
    state.currentUser.activity = '📍 Parado';
  }

  // Atualiza círculo de precisão no mapa
  updateUserAccuracyCircle(lat, lng, accuracy);

  // Transmissão Adaptativa baseada na velocidade do usuário (Economia de Bateria e Dados)
  const now = Date.now();
  let minInterval = 12000; // Parado: a cada 12s

  if (speedKmH > 20) {
    minInterval = 4000; // Dirigindo: a cada 4s
  } else if (speedKmH > 3) {
    minInterval = 7000; // Caminhando: a cada 7s
  }

  if (now - lastBroadcastTime >= minInterval) {
    lastBroadcastTime = now;
    broadcastLocation(state.currentUser);
    broadcastUserUpdate(state.currentUser);
  }

  eventBus.emit('location:updated', state.currentUser);
  throttledReverseGeocode(lat, lng);
}

/**
 * Geocodificação Reversa com Debounce e Threshold de Distância
 */
function throttledReverseGeocode(lat, lng) {
  const now = Date.now();
  if (now - lastGeocodedTime < 25000) return;

  if (lastGeocodedCoords) {
    const distSinceLastGeocode = calculateDistance(
      lastGeocodedCoords.lat,
      lastGeocodedCoords.lng,
      lat,
      lng
    );
    if (distSinceLastGeocode < 40) return;
  }

  lastGeocodedTime = now;
  lastGeocodedCoords = { lat, lng };

  reverseGeocode(lat, lng).then((addr) => {
    if (addr) {
      state.currentUser.address = addr;
      const addrEl = document.getElementById('hud-live-address');
      if (addrEl) addrEl.textContent = addr;
    }
  });
}

/**
 * Inicia o rastreamento contínuo de GPS com máxima precisão
 */
export function startGeolocationTracking() {
  if (!('geolocation' in navigator)) return;

  const onSuccess = (pos) => {
    const { latitude, longitude, accuracy, speed, heading } = pos.coords;
    const speedKmH = speed ? speed * 3.6 : 0;

    updateCurrentUserPosition(latitude, longitude, accuracy, speedKmH, heading);

    const map = getMapInstance();
    if (isAutoFollowUser() && map) {
      map.panTo([latitude, longitude], { animate: true, duration: 0.5 });
    }
  };

  const onError = (err) => {
    console.debug('[GPS Tracker] Status:', err.code, err.message);
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

  // Tick periódico de pulso para garantir que outros membros saibam que estamos online
  const broadcastCurrentTick = () => {
    if (state.currentUser.lat && state.currentUser.lng) {
      state.currentUser.updatedAt = Date.now();
      broadcastLocation(state.currentUser);
      broadcastUserUpdate(state.currentUser);
    }
  };

  // Heartbeat em segundo plano via Web Worker isolado
  startBackgroundHeartbeat(broadcastCurrentTick);

  document.addEventListener('visibilitychange', () => {
    startKeepAlive();
    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      timeout: 5000,
      maximumAge: 0,
    });
  });
}

/**
 * Orientação e Bússola do Dispositivo (Sensor de Giroscópio/Magnetômetro)
 */
export function setupCompassListener() {
  const needleSvg = document.getElementById('compass-needle-svg');

  const handleOrientation = (e) => {
    let heading = null;
    if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
      heading = e.webkitCompassHeading;
    } else if (e.alpha !== null && e.alpha !== undefined) {
      heading = (360 - e.alpha) % 360;
    }

    if (heading !== null && !isNaN(heading)) {
      if (needleSvg) {
        needleSvg.style.transform = `rotate(${-heading}deg)`;
      }
      state.currentUser.heading = Math.round(heading);
      updateUserHeadingCone(Math.round(heading));
    }
  };

  if (window.DeviceOrientationEvent) {
    if (typeof DeviceOrientationEvent.requestPermission !== 'function') {
      window.addEventListener('deviceorientationabsolute', handleOrientation, true);
      window.addEventListener('deviceorientation', handleOrientation, true);
    }
  }
}
