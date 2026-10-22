// Web Audio API Synthesizer - Efeitos Sonoros Táticos em Tempo Real
let audioCtx = null;
let sosOscillator = null;
let sosInterval = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function playTactileClick() {
  // Desativado: Operação 100% silenciosa sem cliques ou ruídos ao tocar nos botões e abas
}

export function playRadarPing() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1320, now);
    osc.frequency.exponentialRampToValueAtTime(1760, now + 0.12);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.19);
  } catch (e) {
    console.debug('Radar ping audio error', e);
  }
}

export function playGeofenceAlert(isEntering = true) {
  // Desativado: Silencioso ao calcular ou alternar lugares e cercas
}

export function startSOSAlarm() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    stopSOSAlarm();

    let high = false;
    const tick = () => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(high ? 960 : 700, ctx.currentTime);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.28);
      high = !high;
    };
    tick();
    sosInterval = setInterval(tick, 320);
  } catch (e) {
    console.debug('SOS audio error', e);
  }
}

export function stopSOSAlarm() {
  if (sosInterval) {
    clearInterval(sosInterval);
    sosInterval = null;
  }
}

// Chime de alta intensidade para "Tocar Som" (Localizar Aparelho / Find My style)
let ringInterval = null;

export function playFindMyChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    stopFindMyChime();

    const chimeCycle = () => {
      const now = ctx.currentTime;
      // Três notas ascendentes penetrantes e claras (C6, E6, C7)
      const tones = [
        { freq: 1046.5, time: now + 0.0, dur: 0.14 },
        { freq: 1318.5, time: now + 0.16, dur: 0.14 },
        { freq: 2093.0, time: now + 0.34, dur: 0.35 },
        { freq: 2093.0, time: now + 0.72, dur: 0.25 },
      ];

      tones.forEach(({ freq, time, dur }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, time);
        gain.gain.setValueAtTime(0.3, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(time);
        osc.stop(time + dur + 0.05);
      });
    };

    chimeCycle();
    ringInterval = setInterval(chimeCycle, 1300);
  } catch (e) {
    console.debug('Find My Chime audio error', e);
  }
}

export function stopFindMyChime() {
  if (ringInterval) {
    clearInterval(ringInterval);
    ringInterval = null;
  }
}

/**
 * Chime suave e harmônico para confirmação de Check-in ("Cheguei Bem 💚")
 */
export function playCheckinSuccess() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    // Três notas ascendentes suaves estilo Apple Pay / Find My (E5, G#5, B5)
    const tones = [
      { freq: 659.25, time: now + 0.0, dur: 0.16 },
      { freq: 830.61, time: now + 0.12, dur: 0.2 },
      { freq: 987.77, time: now + 0.24, dur: 0.38 },
    ];
    tones.forEach(({ freq, time, dur }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, time);
      gain.gain.setValueAtTime(0.18, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(time);
      osc.stop(time + dur + 0.02);
    });
  } catch (e) {
    console.debug('Checkin chime error', e);
  }
}

/**
 * Chime suave estilo iMessage para nova mensagem recebida no Chat E2E
 */
export function playChatMessageSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  } catch (e) {
    console.debug('Chat message sound error', e);
  }
}

