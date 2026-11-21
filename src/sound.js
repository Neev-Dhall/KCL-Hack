// sound.js — tiny synthesised sound effects with the Web Audio API (no audio files).

let audio = null; // created on the first key press / click (browsers require a user action)
let muted = false;

// Call from a click or key press so the browser allows sound.
export function unlockAudio() {
  if (!audio) audio = new AudioContext();
  if (audio.state === 'suspended') audio.resume();
}

export function toggleMute() {
  muted = !muted;
  return muted;
}

export function isMuted() {
  return muted;
}

// One short note. freq → endFreq slides the pitch (for swoops).
function tone(freq, duration, { type = 'square', endFreq = freq, delay = 0, volume = 0.12 } = {}) {
  if (muted || !audio || audio.state !== 'running') return;
  const t = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration); // quick fade out
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + duration);
}

// Plays the sound for a game event (see onEvent in game.js).
export function playEvent(name, value) {
  switch (name) {
    case 'rotate':
      tone(880, 0.05, { volume: 0.06 });
      break;
    case 'hold':
      tone(440, 0.07, { type: 'triangle', volume: 0.2 });
      tone(660, 0.09, { type: 'triangle', volume: 0.2, delay: 0.07 });
      break;
    case 'slam':
      tone(220, 0.18, { type: 'sawtooth', endFreq: 50, volume: 0.18 });
      break;
    case 'clear': {
      // One rising note per line cleared.
      const notes = [523, 659, 784, 1047];
      for (let i = 0; i < value; i++) tone(notes[i], 0.1, { delay: i * 0.07, volume: 0.1 });
      break;
    }
    case 'levelup':
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.1, { delay: i * 0.06, volume: 0.1 }));
      break;
    case 'start':
      tone(330, 0.1, { delay: 0 });
      tone(660, 0.15, { delay: 0.1 });
      break;
    case 'gameover':
      tone(392, 0.6, { type: 'triangle', endFreq: 98, volume: 0.2 });
      break;
  }
}
