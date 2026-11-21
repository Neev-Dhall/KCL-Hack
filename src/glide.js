// glide.js — Hand Glide: steer a neon comet through laser gates.
// Close either hand into a fist to flap (or press Space / ↑ / click).
import './style.css';
import { startTracker, detectHands, drawSkeleton } from './tracker.js';
import { unlockAudio, toggleMute, playEvent, startMusic, stopMusic } from './sound.js';

// =====================================================================
// TUNING — every gameplay and gesture number lives here.
// =====================================================================
const W = 480; // canvas size
const H = 600;
const FLOOR_Y = 560; // top of the neon floor
const ORB_X = 130; // the comet's fixed x position
const ORB_R = 11; // comet radius
const GRAVITY = 1500; // px/s²
const FLAP_VELOCITY = -430; // px/s (negative = up)
const MAX_FALL = 620; // px/s
const GATE_W = 58; // gate thickness
const GATE_SPACING = 240; // horizontal distance between gates
const GAP_START = 185; // opening size at the start…
const GAP_MIN = 135; // …shrinking to this
const GAP_SHRINK = 2.5; // px smaller per gate passed
const SPEED_START = 150; // scroll speed px/s…
const SPEED_MAX = 270; // …up to this
const SPEED_STEP = 4; // px/s faster per gate passed
const RESTART_DELAY_MS = 800; // after a crash, wait this long before a flap restarts

// Fist = flap (either hand). Curl = avg fingertip→wrist distance in palm lengths.
const FIST_CURL = 1.05; // curl below this = fist → flap
const OPEN_CURL = 1.4; // hand must open above this before the next fist counts

const COLORS = ['#ff2bd6', '#00e5ff', '#a259ff', '#c6ff00'];
const FONT = '"Press Start 2P", monospace';

// ---------- Elements ----------
const canvas = document.getElementById('glide');
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const statusEl = document.getElementById('hand-status');
const soundState = document.getElementById('sound-state');

// ---------- State ----------
let state = 'start'; // 'start' | 'playing' | 'paused' | 'over'
let overAt = 0;
let y = H / 2;
let vy = 0;
let gates = []; // { x, gapTop, gap, color, passed }
let trail = []; // recent comet positions
let particles = []; // crash sparks
let score = 0;
let best = loadBest();
let scroll = 0; // background scroll distance
let flashUntil = 0; // "FLAP!" on the camera view
let latestHands = [];
const sides = { left: { armed: false }, right: { armed: false } }; // per-side fist state

// ---------- Game control ----------
function startGame() {
  state = 'playing';
  y = H / 2;
  vy = FLAP_VELOCITY;
  gates = [];
  trail = [];
  particles = [];
  score = 0;
  playEvent('start');
}

function flap() {
  if (state === 'start') return startGame();
  if (state === 'over') {
    if (performance.now() - overAt > RESTART_DELAY_MS) startGame();
    return;
  }
  if (state !== 'playing') return;
  vy = FLAP_VELOCITY;
  playEvent('flap');
}

function crash() {
  state = 'over';
  overAt = performance.now();
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 80 + Math.random() * 260;
    particles.push({ x: ORB_X, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, color: COLORS[i % 4] });
  }
  if (score > best) {
    best = score;
    saveBest(best);
  }
  playEvent('crash');
}

function togglePause() {
  if (state === 'playing') state = 'paused';
  else if (state === 'paused') state = 'playing';
}

// Best score is a per-browser convenience; the game works without storage.
function loadBest() {
  try {
    return Number(localStorage.getItem('handglide-best')) || 0;
  } catch {
    return 0;
  }
}

function saveBest(v) {
  try {
    localStorage.setItem('handglide-best', String(v));
  } catch {
    /* storage unavailable: best score just isn't kept */
  }
}

// ---------- Update ----------
function update(dt) {
  const speed = Math.min(SPEED_MAX, SPEED_START + score * SPEED_STEP);
  scroll += (state === 'playing' ? speed : 60) * dt;

  // Sparks keep flying in every state.
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 600 * dt;
    p.life -= dt * 1.2;
  }
  particles = particles.filter((p) => p.life > 0);

  if (state === 'start') {
    y = H / 2 + Math.sin(performance.now() / 300) * 14; // idle bob
    return;
  }
  if (state !== 'playing') return;

  // Comet physics.
  vy = Math.min(MAX_FALL, vy + GRAVITY * dt);
  y += vy * dt;
  trail.forEach((t) => (t.x -= speed * dt));
  trail.push({ x: ORB_X, y });
  if (trail.length > 14) trail.shift();

  // Move, spawn and score gates.
  gates.forEach((g) => (g.x -= speed * dt));
  gates = gates.filter((g) => g.x > -GATE_W);
  const last = gates[gates.length - 1];
  if (!last || last.x < W - GATE_SPACING) {
    const gap = Math.max(GAP_MIN, GAP_START - score * GAP_SHRINK);
    const gapTop = 50 + Math.random() * (FLOOR_Y - 100 - gap);
    gates.push({ x: W + 10, gapTop, gap, color: COLORS[Math.floor(Math.random() * COLORS.length)], passed: false });
  }
  for (const g of gates) {
    if (!g.passed && g.x + GATE_W < ORB_X - ORB_R) {
      g.passed = true;
      score++;
      // Every 10 gates: level-up jingle and faster music.
      playEvent(score % 10 === 0 ? 'levelup' : 'score', 1 + Math.floor(score / 10));
    }
  }

  // Collisions: ceiling, floor and the two beams of each gate.
  if (y - ORB_R < 0 || y + ORB_R > FLOOR_Y) return crash();
  for (const g of gates) {
    if (hitsRect(g.x, 0, GATE_W, g.gapTop) || hitsRect(g.x, g.gapTop + g.gap, GATE_W, FLOOR_Y)) return crash();
  }
}

// Circle (the comet) vs rectangle, using the closest point on the rectangle.
function hitsRect(rx, ry, rw, rh) {
  const cx = Math.max(rx, Math.min(ORB_X, rx + rw));
  const cy = Math.max(ry, Math.min(y, ry + rh));
  return Math.hypot(ORB_X - cx, y - cy) < ORB_R;
}

// ---------- Hands ----------
function updateHands() {
  const hands = detectHands();
  if (!hands) return; // no new camera frame
  latestHands = hands;

  const bySide = { left: null, right: null };
  for (const h of hands) bySide[h.screenX < 0.5 ? 'left' : 'right'] = h;

  for (const side of ['left', 'right']) {
    const h = bySide[side];
    const s = sides[side];
    if (!h) {
      s.armed = false;
      continue;
    }
    if (h.curl > OPEN_CURL) {
      s.armed = true; // open hand: the next fist will flap
    } else if (s.armed && h.curl < FIST_CURL) {
      s.armed = false; // must open again before the next flap
      flashUntil = performance.now() + 220;
      flap();
    }
  }

  drawOverlay();
  const line = (side, cls) => {
    const h = bySide[side];
    return `<div class="${cls}">${side.toUpperCase()}: ${h ? 'TRACKING · curl ' + h.curl.toFixed(2) + (sides[side].armed ? ' · READY' : '') : 'not seen'}</div>`;
  };
  statusEl.innerHTML = line('left', 'move') + line('right', 'action');
}

function drawOverlay() {
  const w = overlay.width;
  const h = overlay.height;
  octx.clearRect(0, 0, w, h);
  for (const hand of latestHands) drawSkeleton(octx, hand, hand.screenX < 0.5 ? '#00e5ff' : '#ff2bd6');
  if (performance.now() < flashUntil) {
    octx.save();
    octx.font = `16px ${FONT}`;
    octx.textAlign = 'center';
    octx.fillStyle = '#c6ff00';
    octx.shadowColor = '#c6ff00';
    octx.shadowBlur = 12;
    octx.fillText('FLAP!', w / 2, h / 2);
    octx.restore();
  }
}

// ---------- Drawing ----------
function draw() {
  // Sky.
  const sky = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
  sky.addColorStop(0, '#060a1f');
  sky.addColorStop(1, '#1a1050');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  drawStars();
  drawSun();
  drawFloor();
  gates.forEach(drawGate);
  drawComet();
  drawParticles();

  // Faint CRT scanlines.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
  for (let sy = 0; sy < H; sy += 3) ctx.fillRect(0, sy, W, 1);

  drawHud();

  // Neon border.
  ctx.save();
  ctx.strokeStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 12;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);
  ctx.restore();
}

function drawStars() {
  // Two parallax layers of fixed pseudo-random stars.
  for (let layer = 1; layer <= 2; layer++) {
    ctx.fillStyle = layer === 1 ? 'rgba(143,163,255,0.35)' : 'rgba(255,255,255,0.6)';
    for (let i = 0; i < 40; i++) {
      const sx = (((i * 97 * layer) % W) - scroll * 0.1 * layer) % W;
      const x = sx < 0 ? sx + W : sx;
      const sy = (i * 53 * layer) % (FLOOR_Y - 160);
      ctx.fillRect(x, sy, layer, layer);
    }
  }
}

function drawSun() {
  // Striped synthwave sun sitting on the horizon.
  const cx = W / 2;
  const cy = FLOOR_Y - 10;
  const r = 90;
  const g = ctx.createLinearGradient(0, cy - r, 0, cy);
  g.addColorStop(0, '#ffe600');
  g.addColorStop(1, '#ff2bd6');
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#140d40';
  for (let i = 0; i < 6; i++) ctx.fillRect(cx - r, cy - 8 - i * 12, r * 2, 2 + i * 0.6);
  ctx.restore();
}

function drawFloor() {
  ctx.fillStyle = '#0b0630';
  ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 43, 214, 0.55)';
  ctx.lineWidth = 1;
  // Horizontal lines rushing toward the viewer.
  for (let i = 0; i < 6; i++) {
    const t = (i + ((scroll / 40) % 1)) / 6;
    const ly = FLOOR_Y + t * t * (H - FLOOR_Y);
    ctx.beginPath();
    ctx.moveTo(0, ly);
    ctx.lineTo(W, ly);
    ctx.stroke();
  }
  // Perspective lines fanning out from the horizon.
  const off = scroll % 40;
  for (let x = -W; x < W * 2; x += 40) {
    ctx.beginPath();
    ctx.moveTo(W / 2 + (x - off - W / 2) * 0.15, FLOOR_Y);
    ctx.lineTo(x - off, H);
    ctx.stroke();
  }
  ctx.strokeStyle = '#ff2bd6';
  ctx.shadowColor = '#ff2bd6';
  ctx.shadowBlur = 10;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y);
  ctx.lineTo(W, FLOOR_Y);
  ctx.stroke();
  ctx.restore();
}

function drawGate(g) {
  const beams = [
    [0, g.gapTop],
    [g.gapTop + g.gap, FLOOR_Y],
  ];
  ctx.save();
  for (const [top, bottom] of beams) {
    ctx.fillStyle = 'rgba(10, 15, 44, 0.85)';
    ctx.fillRect(g.x, top, GATE_W, bottom - top);
    ctx.strokeStyle = g.color;
    ctx.shadowColor = g.color;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2;
    ctx.strokeRect(g.x + 1, top + 1, GATE_W - 2, bottom - top - 2);
    // Glowing emitter caps at the gap edges.
    ctx.fillStyle = g.color;
    const capY = top === 0 ? bottom - 8 : top;
    ctx.fillRect(g.x - 4, capY, GATE_W + 8, 8);
    // Inner laser line.
    ctx.globalAlpha = 0.5;
    ctx.fillRect(g.x + GATE_W / 2 - 1, top, 2, bottom - top);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawComet() {
  if (state === 'over') return;
  // Fading trail.
  trail.forEach((t, i) => {
    const a = (i + 1) / trail.length;
    ctx.fillStyle = `rgba(0, 229, 255, ${a * 0.35})`;
    ctx.beginPath();
    ctx.arc(t.x, t.y, ORB_R * a * 0.9, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.save();
  ctx.fillStyle = '#ffe600';
  ctx.shadowColor = '#ffe600';
  ctx.shadowBlur = 22;
  ctx.beginPath();
  ctx.arc(ORB_X, y, ORB_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(ORB_X + 3, y - 3, ORB_R * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
  }
  ctx.globalAlpha = 1;
}

function glowText(text, x, ty, size, color) {
  ctx.save();
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  ctx.fillText(text, x, ty);
  ctx.restore();
}

function blink() {
  return Math.floor(performance.now() / 500) % 2 === 0;
}

function drawHud() {
  if (state === 'playing' || state === 'paused') {
    glowText(String(score), W / 2, 70, 36, '#ffffff');
    glowText('BEST ' + best, W / 2, 96, 9, '#8fa3ff');
  }
  if (state === 'start') {
    glowText('HAND', W / 2, 180, 34, '#ff2bd6');
    glowText('GLIDE', W / 2, 228, 34, '#00e5ff');
    glowText('MAKE A FIST TO FLAP', W / 2, 360, 11, '#c6ff00');
    glowText('either hand works', W / 2, 384, 8, '#8fa3ff');
    if (blink()) glowText('FIST OR SPACE TO START', W / 2, 430, 10, '#ffffff');
    if (best) glowText('BEST ' + best, W / 2, 470, 9, '#8fa3ff');
  }
  if (state === 'paused') {
    ctx.fillStyle = 'rgba(6, 10, 31, 0.6)';
    ctx.fillRect(0, 0, W, H);
    glowText('PAUSED', W / 2, 290, 24, '#ffe600');
    glowText('P TO RESUME', W / 2, 330, 10, '#ffffff');
  }
  if (state === 'over') {
    ctx.fillStyle = 'rgba(6, 10, 31, 0.55)';
    ctx.fillRect(0, 0, W, H);
    glowText('CRASHED', W / 2, 220, 28, '#ff2bd6');
    glowText('SCORE ' + score, W / 2, 280, 14, '#c6ff00');
    glowText('BEST ' + best, W / 2, 308, 10, '#8fa3ff');
    if (blink() && performance.now() - overAt > RESTART_DELAY_MS) {
      glowText('FIST OR SPACE TO RETRY', W / 2, 380, 10, '#ffffff');
    }
  }
}

// ---------- Input ----------
window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (['Space', 'ArrowUp'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (['Space', 'ArrowUp', 'KeyW', 'Enter'].includes(e.code)) flap();
  if (e.code === 'KeyP') togglePause();
  if (e.code === 'KeyM') soundState.textContent = toggleMute() ? 'OFF' : 'ON';
});
canvas.addEventListener('pointerdown', () => {
  unlockAudio();
  flap();
});
window.addEventListener('pointerdown', unlockAudio);

// ---------- Camera ----------
const STATUS_TEXT = {
  camera: 'Starting camera…',
  loading: 'Loading hand tracker…',
  ready: 'Show a hand, then make a fist to flap',
  'camera-blocked': 'No camera — keyboard mode',
  'tracker-failed': 'No tracker — keyboard mode',
};
startTracker(document.getElementById('cam'), (s) => {
  statusEl.textContent = STATUS_TEXT[s];
  if (s === 'camera-blocked' || s === 'tracker-failed') {
    const msg = document.getElementById('cam-message');
    msg.innerHTML =
      s === 'camera-blocked'
        ? 'CAMERA BLOCKED<br>Space / click still work.<br>Allow the camera and reload to use hands.'
        : 'TRACKER FAILED TO LOAD<br>Check your internet.<br>Space / click still work.';
    msg.hidden = false;
  }
});

// ---------- Loop ----------
let last = performance.now();
let musicOn = false;

function loop(now) {
  const dt = Math.min(now - last, 50) / 1000; // seconds, clamped
  last = now;
  updateHands();
  update(dt);
  draw();

  const wantMusic = state === 'playing';
  if (wantMusic !== musicOn) {
    if (wantMusic) startMusic();
    else stopMusic();
    musicOn = wantMusic;
  }
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
