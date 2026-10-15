// GeoPulse - Câmera com Realidade Aumentada (AR Precision Finding)
// Orientação 3D espacial com Giroscópio/Magnetômetro e Câmera ao vivo (Estilo Apple AirTag)
import { state } from './sync.js';
import { calculateDistance, calculateBearing, formatDistance } from './geo.js';
import { playRadarPing } from './audio.js';

let activeStream = null;
let activeTargetMember = null;
let currentHeading = 0;
let isLockedOnTarget = false;
let animFrameId = null;
let torchActive = false;

/**
 * Filtro de amortecimento suave para orientação (evita trepidação da câmera)
 */
let smoothedDelta = 0;
let smoothedPitch = 0;

/**
 * Inicializa a câmera traseira do celular e o visor AR
 */
export async function openARFinder(targetMember) {
  if (!targetMember) return;
  activeTargetMember = targetMember;

  const modal = document.getElementById('modal-ar-finder');
  const video = document.getElementById('ar-video-feed');
  const fallbackHud = document.getElementById('ar-fallback-hud');

  if (modal) modal.style.display = 'flex';

  updateTargetUI(targetMember);

  // 1. Tenta inicializar a câmera do celular
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      activeStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      if (video) {
        video.srcObject = activeStream;
        video.style.display = 'block';
        await video.play();
      }
      if (fallbackHud) fallbackHud.style.display = 'none';
    } else {
      throw new Error('Câmera não suportada neste navegador.');
    }
  } catch (err) {
    console.warn('[AR Finder] Não foi possível abrir câmera (usando radar espacial):', err);
    if (video) video.style.display = 'none';
    if (fallbackHud) fallbackHud.style.display = 'flex';
  }

  // 2. Inicia o listener de orientação da bússola
  setupAROrientation();

  // 3. Inicia loop de renderização 60fps do visor 3D
  startARLoop();
}

/**
 * Encerra o visor AR e desliga a câmera do celular
 */
export function closeARFinder() {
  const modal = document.getElementById('modal-ar-finder');
  const video = document.getElementById('ar-video-feed');

  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  window.removeEventListener('deviceorientation', handleOrientationEvent, true);
  window.removeEventListener('deviceorientationabsolute', handleOrientationEvent, true);

  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }

  if (video) {
    video.srcObject = null;
  }

  torchActive = false;
  isLockedOnTarget = false;
  activeTargetMember = null;

  if (modal) modal.style.display = 'none';
}

/**
 * Liga / desliga a lanterna do celular no modo AR se suportado
 */
export async function toggleARTorch() {
  if (!activeStream) return false;
  const track = activeStream.getVideoTracks()[0];
  if (!track) return false;

  try {
    const capabilities = track.getCapabilities ? track.getCapabilities() : {};
    if (capabilities.torch) {
      torchActive = !torchActive;
      await track.applyConstraints({
        advanced: [{ torch: torchActive }],
      });
      const btnTorch = document.getElementById('btn-ar-torch');
      if (btnTorch) {
        btnTorch.classList.toggle('active', torchActive);
      }
      return torchActive;
    }
  } catch (e) {
    console.debug('[AR Torch] Falha ao alternar lanterna:', e);
  }
  return false;
}

/**
 * Atualiza os dados do card do membro no HUD
 */
function updateTargetUI(member) {
  const nameEl = document.getElementById('ar-target-name');
  const avatarEl = document.getElementById('ar-target-avatar');

  if (nameEl) nameEl.textContent = member.name;
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
}

/**
 * Configura os listeners dos sensores de giroscópio e bússola
 */
async function setupAROrientation() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') {
        console.warn('[AR] Permissão de giroscópio negada.');
      }
    } catch (e) {}
  }

  window.addEventListener('deviceorientationabsolute', handleOrientationEvent, true);
  window.addEventListener('deviceorientation', handleOrientationEvent, true);
}

function handleOrientationEvent(e) {
  let heading = null;

  // iOS Safari
  if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
    heading = e.webkitCompassHeading;
  }
  // Android Chrome com bússola absoluta
  else if (e.alpha !== null && e.alpha !== undefined) {
    heading = (360 - e.alpha) % 360;
  }

  if (heading !== null && !isNaN(heading)) {
    currentHeading = heading;
  }

  // Pitch (inclinação vertical do aparelho)
  if (e.beta !== null && e.beta !== undefined) {
    smoothedPitch = smoothedPitch * 0.8 + e.beta * 0.2;
  }
}

/**
 * Loop de Renderização Contínua a 60 FPS
 */
function startARLoop() {
  const arrowEl = document.getElementById('ar-direction-arrow');
  const distanceEl = document.getElementById('ar-distance-readout');
  const angleHintEl = document.getElementById('ar-angle-hint');
  const reticleRing = document.getElementById('ar-reticle-ring');
  const radarRadarDot = document.getElementById('ar-radar-target-dot');

  function render() {
    if (!activeTargetMember) return;

    if (activeTargetMember.id && state.members.has(activeTargetMember.id)) {
      activeTargetMember = state.members.get(activeTargetMember.id);
    }

    const myLat = state.currentUser.lat;
    const myLng = state.currentUser.lng;
    const targetLat = activeTargetMember.lat;
    const targetLng = activeTargetMember.lng;

    if (!myLat || !myLng || !targetLat || !targetLng) {
      if (angleHintEl) {
        angleHintEl.innerHTML = `🛰️ <strong>Sintonizando GPS</strong> · Aguardando coordenadas...`;
      }
      animFrameId = requestAnimationFrame(render);
      return;
    }

    // Distância métrica real
    const distMeters = calculateDistance(myLat, myLng, targetLat, targetLng);
    if (distanceEl) {
      distanceEl.textContent = formatDistance(distMeters);
    }

    // Ângulo absoluto em relação ao Norte (Bearing)
    const bearing = calculateBearing(myLat, myLng, targetLat, targetLng);

    // Delta relativo: para onde o usuário deve virar (-180° a +180°)
    let delta = (bearing - currentHeading + 540) % 360 - 180;

    // Suavização exponencial para eliminar jitter da mão
    smoothedDelta = smoothedDelta * 0.75 + delta * 0.25;

    // Rotação da seta 3D no centro da tela
    if (arrowEl) {
      arrowEl.style.transform = `rotate(${smoothedDelta}deg)`;
    }

    // Mini-radar no topo
    if (radarRadarDot) {
      const radAngle = (smoothedDelta * Math.PI) / 180;
      const radarDist = Math.min(28, Math.max(8, distMeters / 15));
      const dotX = Math.sin(radAngle) * radarDist;
      const dotY = -Math.cos(radAngle) * radarDist;
      radarRadarDot.style.transform = `translate(${dotX}px, ${dotY}px)`;
    }

    // Feedback de Alinhamento (Dentro de ±18 graus: "Alvo Alinhado!")
    const isAligned = Math.abs(smoothedDelta) <= 18;

    if (reticleRing) {
      reticleRing.classList.toggle('locked-on', isAligned);
    }

    if (isAligned) {
      if (!isLockedOnTarget) {
        isLockedOnTarget = true;
        playRadarPing();
        if (navigator.vibrate) {
          try { navigator.vibrate([30, 40]); } catch (e) {}
        }
      }
      if (angleHintEl) {
        angleHintEl.innerHTML = `🎯 <strong>Em frente!</strong> Continue nessa direção`;
        angleHintEl.className = 'ar-hint-pill locked';
      }
    } else {
      isLockedOnTarget = false;
      const degreesDiff = Math.abs(Math.round(smoothedDelta));

      if (angleHintEl) {
        if (degreesDiff >= 135) {
          angleHintEl.innerHTML = `🔄 <strong>Atrás de você</strong> · Gire o corpo 180°`;
          angleHintEl.className = 'ar-hint-pill behind';
        } else if (smoothedDelta > 0) {
          angleHintEl.innerHTML = `👉 <strong>Vire à direita</strong> · ${degreesDiff}°`;
          angleHintEl.className = 'ar-hint-pill right';
        } else {
          angleHintEl.innerHTML = `👈 <strong>Vire à esquerda</strong> · ${degreesDiff}°`;
          angleHintEl.className = 'ar-hint-pill left';
        }
      }
    }

    animFrameId = requestAnimationFrame(render);
  }

  animFrameId = requestAnimationFrame(render);
}
