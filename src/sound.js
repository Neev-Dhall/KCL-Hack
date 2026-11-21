// sound.js — synthesised sound effects and background music with the
// Web Audio API (no audio files).

let audio = null; // created on the first key press / click (browsers require a user action)
let master = null; // everything goes through this, so mute is one switch
let musicBus = null; // background music volume
let muted = false;

// Call from a click or key press so the browser allows sound.
export function unlockAudio() {
  if (!audio) {
    audio = new AudioContext();
    master = audio.createGain();
    master.connect(audio.destination);
    musicBus = audio.createGain();
    musicBus.gain.value = 0.5;
    musicBus.connect(master);
    master.gain.value = muted ? 0 : 1;
  }
  if (audio.state === 'suspended') audio.resume();
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 1;
  return muted;
}

function ready() {
  return audio && audio.state === 'running';
}

// One short note. freq → endFreq slides the pitch (for swoops).
function tone(freq, duration, { type = 'square', endFreq = freq, delay = 0, volume = 0.12, at, dest } = {}) {
  if (!ready()) return;
  const t = (at ?? audio.currentTime) + delay;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration); // quick fade out
  osc.connect(gain).connect(dest || master);
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
      setMusicLevel(value);
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.1, { delay: i * 0.06, volume: 0.1 }));
      break;
    case 'start':
      setMusicLevel(1);
      tone(330, 0.1, { delay: 0 });
      tone(660, 0.15, { delay: 0.1 });
      break;
    case 'gameover':
      tone(392, 0.6, { type: 'triangle', endFreq: 98, volume: 0.2 });
      break;
  }
}

// =====================================================================
// Background music: an original 4-bar loop (Am – F – C – G) played by a
// tiny step sequencer. Each bar is 16 steps (sixteenth notes).
// =====================================================================
const CHORDS = [
  { bass: 45, tones: [57, 60, 64] }, // A minor
  { bass: 41, tones: [53, 57, 60] }, // F major
  { bass: 48, tones: [55, 60, 64] }, // C major
  { bass: 43, tones: [55, 59, 62] }, // G major
];
// Which chord tone the arpeggio plays on each step (3 = top note an octave up).
const ARP = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 2, 3, 2];
const BASS_STEPS = { 0: 0, 4: 0, 6: 12, 8: 0, 12: 0, 14: 12 }; // step → octave shift
const BASE_BPM = 112; // tempo at level 1…
const BPM_PER_LEVEL = 6; // …speeds up each level…
const MAX_BPM = 170; // …up to this

let musicTimer = null;
let step = 0; // 0..63 across the 4 bars
let nextStepTime = 0;
let bpm = BASE_BPM;

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function setMusicLevel(level) {
  bpm = Math.min(MAX_BPM, BASE_BPM + (level - 1) * BPM_PER_LEVEL);
}

export function startMusic() {
  if (musicTimer) return;
  step = 0;
  nextStepTime = 0;
  // Schedule notes a little ahead of time on the audio clock so timing stays tight.
  musicTimer = setInterval(scheduleMusic, 25);
}

export function stopMusic() {
  clearInterval(musicTimer);
  musicTimer = null;
}

function scheduleMusic() {
  if (!ready()) return; // waits silently until the first click / key press
  if (nextStepTime < audio.currentTime) nextStepTime = audio.currentTime + 0.05;
  const stepLength = 60 / bpm / 4; // one sixteenth note
  while (nextStepTime < audio.currentTime + 0.12) {
    playStep(step, nextStepTime, stepLength);
    nextStepTime += stepLength;
    step = (step + 1) % 64;
  }
}

function playStep(s, time, len) {
  const chord = CHORDS[Math.floor(s / 16)];
  const inBar = s % 16;

  // Arpeggio lead (top note = first chord tone an octave up).
  const idx = ARP[inBar];
  const note = idx === 3 ? chord.tones[0] + 12 : chord.tones[idx];
  tone(midiToFreq(note + 12), len * 0.9, { at: time, volume: 0.05, dest: musicBus });

  // Bass.
  if (inBar in BASS_STEPS) {
    tone(midiToFreq(chord.bass + BASS_STEPS[inBar]), len * 1.8, {
      at: time,
      type: 'triangle',
      volume: 0.22,
      dest: musicBus,
    });
  }

  // Soft tick on the beat for drive.
  if (inBar % 4 === 0) tone(2400, 0.02, { at: time, volume: 0.03, dest: musicBus, endFreq: 1200 });
}
