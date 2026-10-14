// Módulo de Persistência em Segundo Plano & GPS Contínuo 24h
// Opera 100% silencioso e invisível: SEM widget de player de música na tela de bloqueio (iOS / Android)

let isKeepAliveActive = true;
let isAudioUnlocked = false;
let audioCtx = null;
let silentSource = null;
let bgWorker = null;

/**
 * Remove qualquer resquício de MediaSession para NUNCA exibir player na tela bloqueada ou Dynamic Island
 */
export function clearMediaSessionWidget() {
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      const actions = ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack'];
      actions.forEach((act) => {
        try {
          navigator.mediaSession.setActionHandler(act, null);
        } catch (e) {}
      });
    } catch (err) {
      console.debug('[KeepAlive] Limpeza de MediaSession:', err);
    }
  }
}

/**
 * Utiliza Web Audio API de baixo nível:
 * Mantém o pipeline de áudio ativo sem acionar o MPNowPlayingInfoCenter do iOS (sem widget de música)
 */
function startSilentWebAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContextClass();
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    if (!silentSource) {
      // Buffer mono com zeros absolutos (silêncio digital)
      const sampleRate = audioCtx.sampleRate || 44100;
      const buffer = audioCtx.createBuffer(1, sampleRate * 2, sampleRate);
      silentSource = audioCtx.createBufferSource();
      silentSource.buffer = buffer;
      silentSource.loop = true;

      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.00001, audioCtx.currentTime);

      silentSource.connect(gain);
      gain.connect(audioCtx.destination);
      silentSource.start(0);
    }
  } catch (err) {
    console.debug('[KeepAlive] Web Audio silent start error:', err);
  }
}

/**
 * Worker em segundo plano: dispara pulso a cada 4 segundos independente de throttling da aba
 */
export function startBackgroundHeartbeat(onTick) {
  try {
    if (bgWorker) {
      bgWorker.terminate();
      bgWorker = null;
    }
    const workerScript = `
      let intervalId = null;
      self.onmessage = function(e) {
        if (e.data === 'START') {
          if (intervalId) clearInterval(intervalId);
          intervalId = setInterval(function() {
            self.postMessage('TICK');
          }, 4000);
        } else if (e.data === 'STOP') {
          if (intervalId) clearInterval(intervalId);
          intervalId = null;
        }
      };
    `;
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    bgWorker = new Worker(URL.createObjectURL(blob));
    bgWorker.onmessage = function(e) {
      if (e.data === 'TICK' && onTick) {
        onTick();
      }
    };
    bgWorker.postMessage('START');
    console.log('[KeepAlive] Web Worker de persistência ativo (sem widget de mídia).');
  } catch (err) {
    console.debug('[KeepAlive] Web Worker não suportado:', err);
  }
}

/**
 * Inicia o keep-alive invisível
 */
export async function startKeepAlive() {
  isKeepAliveActive = true;
  clearMediaSessionWidget();
  startSilentWebAudio();
  isAudioUnlocked = true;
}

/**
 * Pausa o keep-alive
 */
export function pauseKeepAlive() {
  isKeepAliveActive = false;
  clearMediaSessionWidget();
  if (audioCtx && audioCtx.state === 'running') {
    audioCtx.suspend().catch(() => {});
  }
  if (silentSource) {
    try {
      silentSource.stop();
    } catch (e) {}
    silentSource = null;
  }
}

/**
 * Inicializa a persistência invisível no primeiro toque da tela
 */
export function initAutoKeepAlive() {
  clearMediaSessionWidget();

  const unlockAndStart = () => {
    if (!isAudioUnlocked) {
      startKeepAlive();
    }
  };

  window.addEventListener('pointerdown', unlockAndStart, { once: true, passive: true });
  window.addEventListener('touchstart', unlockAndStart, { once: true, passive: true });
  window.addEventListener('click', unlockAndStart, { once: true, passive: true });

  // Monitora mudança de visibilidade (tela bloqueada / app minimizado)
  document.addEventListener('visibilitychange', () => {
    clearMediaSessionWidget();
    if (isKeepAliveActive && audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  });

  // Tenta iniciar imediatamente
  startKeepAlive().catch(() => {});
}
