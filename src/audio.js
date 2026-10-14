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
    audioCtx.resume();
  }
  return audioCtx;
}

export function playTactileClick() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.04);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
  } catch (e) {
    console.debug('Audio not allowed yet', e);
  }
}

export function playRadarPing() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1240, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(620, ctx.currentTime + 0.35);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  } catch (e) {
    console.debug('Audio error', e);
  }
}

export function playGeofenceAlert(isEntering = true) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const notes = isEntering ? [523.25, 659.25, 783.99] : [783.99, 587.33, 440];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + idx * 0.1;
      osc.type = isEntering ? 'triangle' : 'sawtooth';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.12, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    });
  } catch (e) {
    console.debug('Audio error', e);
  }
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

