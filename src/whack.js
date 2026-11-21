// whack.js — Hand Whack: neon moles pop out of a 3×3 grid of holes; bop them
// before they duck back down. Each hand is a hammer: move your palm to aim at
// a hole, squeeze your hand (a quick fist) to whack. Two hands = two hammers.
// Golden moles are worth extra; bombs cost you time. 60-second rounds.
// Keyboard: 1–9 (or the numpad) whack a hole; click works too.
import './style.css';
import { startTracker, detectHands, drawSkeleton } from './tracker.js';
import { unlockAudio, toggleMute, playEvent, startMusic, stopMusic } from './sound.js';
import { createHandMenu } from './handmenu.js';

// =====================================================================
// TUNING — every gameplay and gesture number lives here.
// =====================================================================
const W = 480; // canvas size
const H = 600;
const COLS_X = [90, 240, 390]; // hole centres
const ROWS_Y = [250, 385, 520];
const HOLE_RX = 60; // hole ellipse radii
const HOLE_RY = 18;
const MOLE_R = 40; // mole body radius
const RISE = 70; // how far a mole sticks out, px

const ROUND_S = 60; // seconds per round
const SPAWN_START_MS = 950; // gap between pops at the start…
const SPAWN_END_MS = 420; // …down to this by the end
const UP_START_MS = 1350; // how long a mole stays up at the start…
const UP_END_MS = 650; // …down to this by the end
const POP_MS = 130; // time to pop up / duck down
const MAX_UP_START = 2; // moles up at once at the start…
const MAX_UP_END = 4; // …up to this by the end
const GOLD_CHANCE = 0.08;
const BOMB_CHANCE = 0.14; // only after BOMBS_FROM_S
const BOMBS_FROM_S = 10;
const BOMB_PENALTY_S = 5; // whacking a bomb costs this much time
const POINTS = { mole: 10, gold: 50 };
const COMBO_STEP = 5; // every 5 hits in a row raises the multiplier…
const MAX_MULT = 5; // …up to ×5
const RESTART_DELAY_MS = 900; // after time's up, wait before a squeeze restarts
const SHAKE_MS = 300;

// Hammers: the palm's position in the (mirrored) camera frame maps onto the
// board. This box of the frame covers the whole grid, so you needn't reach.
const AIM_X = [0.18, 0.82];
const AIM_Y = [0.2, 0.8];
const AIM_SMOOTH = 0.45; // EMA weight for the newest palm position
// A whack is a squeeze: curl (avg fingertip→wrist distance in palm lengths,
// open ≈ 1.9, fist ≈ 0.9) dropping this far below its recent high.
const SQUEEZE_DROP = 0.35;
const REOPEN_RISE = 0.2; // curl climbs this much above its recent low → ready again
const HAND_LOST_MS = 300;

const FONT = '"Press Start 2P", monospace';
const HAMMER_COLORS = ['#00e5ff', '#ff2bd6']; // left hand, right hand
const BEST_KEY = 'handarcade.best.whack';

// ---------- Elements ----------
const canvas = document.getElementById('whack');
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const statusEl = document.getElementById('hand-status');
const soundState = document.getElementById('sound-state');
const debugEl = document.getElementById('debug');
const controlsEl = document.getElementById('controls');

const HOLES = ROWS_Y.flatMap((y) => COLS_X.map((x) => ({ x, y })));

// ---------- State ----------
let state = 'start'; // 'start' | 'playing' | 'paused' | 'over'
let overAt = 0;
let score = 0;
let best = loadBest();
let newBest = false;
let timeLeft = ROUND_S;
let elapsed = 0;
let level = 1;
let combo = 0;
let hits = 0;
let misses = 0;
let moles = []; // { hole, type, age, upMs, hitAt }
let nextSpawn = 0;
let particles = [];
let popups = []; // floating text
let shakeUntil = 0;
let debugOn = false;

// Hammers (index 0 = left-most hand on screen, 1 = right-most).
const hammers = [newHammer(), newHammer()];
let trackerReady = false;
let latestHands = [];
let fps = 0;
let fpsFrames = 0;
let fpsStart = 0;

function newHammer() {
  return { x: null, y: null, hole: -1, seen: -Infinity, swingAt: -Infinity, squeeze: newDetector(), curl: null };
}

// ---------- Game flow ----------
function startGame() {
  unlockAudio();
  state = 'playing';
  score = 0;
  timeLeft = ROUND_S;
  elapsed = 0;
  level = 1;
  combo = 0;
  hits = 0;
  misses = 0;
  moles = [];
  particles = [];
  popups = [];
  nextSpawn = 0.6;
  newBest = false;
  playEvent('start');
}

function endGame() {
  state = 'over';
  overAt = performance.now();
  moles = [];
  if (score > best) {
    best = score;
    newBest = true;
    saveBest(best);
  }
  playEvent('gameover');
}

function togglePause() {
  if (state === 'playing') state = 'paused';
  else if (state === 'paused') state = 'playing';
}

// Squeeze / Space: start or restart from the menu screens.
function startOrRestart() {
  if (state === 'start') startGame();
  else if (state === 'over' && performance.now() - overAt > RESTART_DELAY_MS) startGame();
}

function loadBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest(v) {
  try {
    localStorage.setItem(BEST_KEY, String(v));
  } catch {
    /* storage unavailable: the best score just isn't kept */
  }
}

const lerp = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));
const progress = () => elapsed / ROUND_S; // 0 → 1 across the round

// ---------- Whacking ----------
function whack(holeIndex, hammer) {
  if (hammer) hammer.swingAt = performance.now();
  if (state !== 'playing') return startOrRestart();
  playEvent('slam');
  const hole = HOLES[holeIndex];
  const mole = moles.find((m) => m.hole === holeIndex && m.hitAt === null && heightOf(m) > 0.35);
  burst(hole.x, hole.y - 10, '#ffffff', 6);
  if (!mole) {
    combo = 0; // a whiff breaks the combo
    return;
  }
  mole.hitAt = mole.age;
  if (mole.type === 'bomb') {
    timeLeft = Math.max(0, timeLeft - BOMB_PENALTY_S);
    combo = 0;
    shakeUntil = performance.now() + SHAKE_MS;
    burst(hole.x, hole.y - 30, '#ff3b3b', 26);
    popup(`-${BOMB_PENALTY_S}s`, hole.x, hole.y - 70, '#ff3b3b');
    playEvent('crash');
    return;
  }
  combo++;
  hits++;
  const mult = multiplier();
  const pts = POINTS[mole.type] * mult;
  score += pts;
  burst(hole.x, hole.y - 30, mole.type === 'gold' ? '#ffd400' : '#a259ff', mole.type === 'gold' ? 24 : 14);
  popup(`+${pts}`, hole.x, hole.y - 70, mole.type === 'gold' ? '#ffd400' : '#c6ff00');
  if (mole.type === 'gold') playEvent('clear', 3);
  else playEvent('score');
  if (combo % COMBO_STEP === 0 && mult < MAX_MULT) popup(`×${multiplier()} COMBO`, W / 2, 175, '#ffe600');
}

function multiplier() {
  return Math.min(MAX_MULT, 1 + Math.floor(combo / COMBO_STEP));
}

// 0 (in the hole) → 1 (fully up), following pop-up / stay / duck-down.
function heightOf(m) {
  if (m.hitAt !== null) return Math.max(0, 1 - (m.age - m.hitAt) / 160); // squashed back down
  if (m.age < POP_MS) return m.age / POP_MS;
  if (m.age > m.upMs - POP_MS) return Math.max(0, (m.upMs - m.age) / POP_MS);
  return 1;
}

// ---------- Update ----------
function update(dt) {
  const s = dt / 1000;
  for (const p of particles) {
    p.x += p.vx * s;
    p.y += p.vy * s;
    p.vy += 900 * s;
    p.life -= s;
  }
  particles = particles.filter((p) => p.life > 0);
  for (const p of popups) {
    p.y -= 40 * s;
    p.life -= s;
  }
  popups = popups.filter((p) => p.life > 0);

  if (state !== 'playing') return;

  elapsed += s;
  timeLeft -= s;
  if (timeLeft <= 0) {
    timeLeft = 0;
    return endGame();
  }

  const newLevel = 1 + Math.floor(elapsed / 15);
  if (newLevel !== level) {
    level = newLevel;
    playEvent('levelup', level);
  }

  for (const m of moles) m.age += dt;
  for (const m of moles) {
    if (m.hitAt === null && m.age >= m.upMs && m.type !== 'bomb') {
      combo = 0; // one got away
      misses++;
    }
  }
  moles = moles.filter((m) => (m.hitAt === null ? m.age < m.upMs : m.age - m.hitAt < 400));

  nextSpawn -= s;
  const maxUp = Math.round(lerp(MAX_UP_START, MAX_UP_END, progress()));
  if (nextSpawn <= 0 && moles.length < maxUp) {
    spawnMole();
    nextSpawn = lerp(SPAWN_START_MS, SPAWN_END_MS, progress()) / 1000 * (0.7 + Math.random() * 0.6);
  }
}

function spawnMole() {
  const free = HOLES.map((_, i) => i).filter((i) => !moles.some((m) => m.hole === i));
  if (!free.length) return;
  const hole = free[Math.floor(Math.random() * free.length)];
  const r = Math.random();
  let type = 'mole';
  if (r < GOLD_CHANCE) type = 'gold';
  else if (elapsed > BOMBS_FROM_S && r < GOLD_CHANCE + BOMB_CHANCE) type = 'bomb';
  let upMs = lerp(UP_START_MS, UP_END_MS, progress()) * (0.85 + Math.random() * 0.3);
  if (type === 'gold') upMs *= 0.7; // golden moles are quick
  moles.push({ hole, type, age: 0, upMs, hitAt: null });
}

function burst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 120 + Math.random() * 260;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 200, life: 0.5 + Math.random() * 0.3, color });
  }
}

function popup(text, x, y, color) {
  popups.push({ text, x, y, color, life: 0.8 });
}

// ---------- Tracking ----------
function nearestHole(x, y) {
  let bestI = 0;
  let bestD = Infinity;
  HOLES.forEach((h, i) => {
    const d = Math.hypot(h.x - x, (h.y - y) * 1.1);
    if (d < bestD) [bestD, bestI] = [d, i];
  });
  return bestI;
}

// Palm position in the mirrored camera frame → board coordinates.
function aimToBoard(sx, sy) {
  const fx = (sx - AIM_X[0]) / (AIM_X[1] - AIM_X[0]);
  const fy = (sy - AIM_Y[0]) / (AIM_Y[1] - AIM_Y[0]);
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return {
    x: lerp(COLS_X[0] - 70, COLS_X[2] + 70, clamp(fx)),
    y: lerp(ROWS_Y[0] - 60, ROWS_Y[2] + 30, clamp(fy)),
  };
}

function updateHands() {
  const hands = detectHands();
  if (!hands) return; // no new camera frame
  const now = performance.now();
  latestHands = hands;
  menu.feed(hands.map((h) => ({ x: h.screenX, y: h.landmarks[9].y })));
  fpsFrames++;
  if (now - fpsStart >= 1000) {
    fps = fpsFrames;
    fpsFrames = 0;
    fpsStart = now;
  }

  // Left-most hand → hammer 0, right-most → hammer 1. With one hand, the
  // screen side decides, so a hand keeps its colour as it moves.
  const sorted = [...hands].sort((a, b) => a.screenX - b.screenX).slice(0, 2);
  const assigned = [null, null];
  if (sorted.length === 2) [assigned[0], assigned[1]] = sorted;
  else if (sorted.length === 1) assigned[sorted[0].screenX < 0.5 ? 0 : 1] = sorted[0];

  hammers.forEach((hm, i) => {
    const h = assigned[i];
    if (!h) {
      hm.squeeze = newDetector(); // forget until the hand comes back
      hm.curl = null;
      return;
    }
    const t = aimToBoard(h.screenX, h.landmarks[9].y);
    const fresh = now - hm.seen > HAND_LOST_MS || hm.x === null;
    hm.x = fresh ? t.x : hm.x + AIM_SMOOTH * (t.x - hm.x);
    hm.y = fresh ? t.y : hm.y + AIM_SMOOTH * (t.y - hm.y);
    hm.seen = now;
    hm.curl = h.curl;
    // Aim is locked while the hand is closing, so the squeeze can't drag it
    // onto the neighbouring hole.
    if (hm.squeeze.armed || hm.hole < 0) hm.hole = nearestHole(hm.x, hm.y);
    if (updateDetector(hm.squeeze, h.curl, SQUEEZE_DROP, REOPEN_RISE)) whack(hm.hole, hm);
  });

  drawOverlay();
  const line = (i, cls, name) => {
    const hm = hammers[i];
    return `<div class="${cls}">${name}: ${hm.curl !== null ? 'HAMMER · curl ' + hm.curl.toFixed(2) + (hm.squeeze.armed ? ' · READY' : ' · open to re-arm') : 'not seen'}</div>`;
  };
  statusEl.innerHTML = line(0, 'move', 'LEFT') + line(1, 'action', 'RIGHT');
  if (debugOn) renderDebug();
}

const hammerLive = (hm) => performance.now() - hm.seen < HAND_LOST_MS && hm.x !== null;

// ---------- Squeeze detector (same idea as Hand Glide's) ----------
function newDetector() {
  return { armed: false, value: null, high: null, low: null };
}

// Returns true once per squeeze: curl falling `drop` below its recent high.
// It then re-arms once curl climbs `rise` above its recent low.
function updateDetector(s, value, drop, rise) {
  s.value = value;
  if (s.high === null) {
    s.armed = true;
    s.high = s.low = value;
    return false;
  }
  if (s.armed) {
    s.high = Math.max(s.high, value);
    if (s.high - value >= drop) {
      s.armed = false;
      s.low = value;
      return true;
    }
  } else {
    s.low = Math.min(s.low, value);
    if (value - s.low >= rise) {
      s.armed = true;
      s.high = value;
    }
  }
  return false;
}

// ---------- Camera overlay: the aiming grid and both hands ----------
function drawOverlay() {
  const w = overlay.width;
  const h = overlay.height;
  octx.clearRect(0, 0, w, h);
  const x0 = AIM_X[0] * w;
  const y0 = AIM_Y[0] * h;
  const cw = ((AIM_X[1] - AIM_X[0]) * w) / 3;
  const ch = ((AIM_Y[1] - AIM_Y[0]) * h) / 3;
  octx.save();
  octx.strokeStyle = 'rgba(198, 255, 0, 0.35)';
  octx.lineWidth = 1;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const aimed = hammers.findIndex((hm) => hammerLive(hm) && hm.hole === i);
      if (aimed >= 0) {
        octx.fillStyle = HAMMER_COLORS[aimed] + '33';
        octx.fillRect(x0 + c * cw, y0 + r * ch, cw, ch);
      }
      octx.strokeRect(x0 + c * cw + 0.5, y0 + r * ch + 0.5, cw, ch);
    }
  }
  octx.restore();
  for (const hand of latestHands) drawSkeleton(octx, hand, hand.screenX < 0.5 ? HAMMER_COLORS[0] : HAMMER_COLORS[1]);
}

function renderDebug() {
  const n = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
  const info = (s) =>
    s.value === null ? '—' : s.armed ? `drop ${(s.high - s.value).toFixed(2)} / ${SQUEEZE_DROP}` : `rise ${(s.value - s.low).toFixed(2)} / ${REOPEN_RISE}`;
  const rows = [
    ['TRACKER', `hands · ${fps} fps · ${latestHands.length} seen`, '', false],
    ['left curl', n(hammers[0].curl), info(hammers[0].squeeze), hammers[0].squeeze.armed],
    ['left aim', hammerLive(hammers[0]) ? `hole ${hammers[0].hole + 1}` : '—', '1–9', false],
    ['right curl', n(hammers[1].curl), info(hammers[1].squeeze), hammers[1].squeeze.armed],
    ['right aim', hammerLive(hammers[1]) ? `hole ${hammers[1].hole + 1}` : '—', '1–9', false],
    ['moles up', String(moles.length), `level ${level}`, false],
  ];
  debugEl.innerHTML =
    '<table>' +
    rows.map(([a, b, c, on]) => `<tr class="${on ? 'on' : ''}"><td>${a}</td><td>${b}</td><td>${c}</td></tr>`).join('') +
    '</table>';
}

function renderControls() {
  controlsEl.innerHTML = `<div class="ctl-col move"><b>AIM</b><span>MOVE PALM · PICK HOLE</span><span>TWO HANDS = TWO HAMMERS</span></div>
    <div class="ctl-col action"><b>WHACK</b><span>SQUEEZE HAND · BOP</span><span>OPEN AGAIN · RELOAD</span></div>`;
}

// ---------- Drawing ----------
function glowText(text, x, y, size, color, align = 'center') {
  ctx.save();
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.fillText(text, x, y);
  ctx.restore();
}

const blink = () => Math.floor(performance.now() / 500) % 2 === 0;

function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#120a36');
  g.addColorStop(1, '#050816');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Perspective neon grid as the ground.
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 43, 214, 0.22)';
  ctx.lineWidth = 1;
  const horizon = 165;
  for (let i = -8; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(W / 2 + i * 12, horizon);
    ctx.lineTo(W / 2 + i * 110, H);
    ctx.stroke();
  }
  const scroll = (performance.now() / 1000) % 1;
  for (let k = 0; k < 10; k++) {
    const t = (k + scroll) / 10;
    const y = horizon + (H - horizon) * t * t;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHole(i, front) {
  const { x, y } = HOLES[i];
  ctx.save();
  if (!front) {
    ctx.fillStyle = '#02030b';
    ctx.beginPath();
    ctx.ellipse(x, y, HOLE_RX, HOLE_RY, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const aimed = hammers.findIndex((hm) => hammerLive(hm) && hm.hole === i);
  const color = aimed >= 0 ? HAMMER_COLORS[aimed] : '#a259ff';
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = aimed >= 0 ? 18 : 8;
  ctx.lineWidth = aimed >= 0 ? 4 : 3;
  ctx.beginPath();
  // The back draws the far rim, the front the near rim (over the mole).
  if (front) ctx.ellipse(x, y, HOLE_RX, HOLE_RY, 0, 0, Math.PI);
  else ctx.ellipse(x, y, HOLE_RX, HOLE_RY, 0, Math.PI, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  if (!front && state === 'playing') glowText(String(i + 1), x + HOLE_RX - 4, y + HOLE_RY + 14, 7, 'rgba(143,163,255,0.6)');
}

function drawMole(m) {
  const { x, y } = HOLES[m.hole];
  const hgt = heightOf(m);
  if (hgt <= 0) return;
  const cy = y + MOLE_R - RISE * hgt + 6; // body centre
  const hit = m.hitAt !== null;
  const body = { mole: '#a259ff', gold: '#ffd400', bomb: '#262233' }[m.type];
  const glow = { mole: '#00e5ff', gold: '#ffd400', bomb: '#ff3b3b' }[m.type];

  ctx.save();
  // Only the part above the hole's centre line shows.
  ctx.beginPath();
  ctx.rect(x - HOLE_RX, y - 200, HOLE_RX * 2, 200);
  ctx.clip();
  ctx.fillStyle = body;
  ctx.shadowColor = glow;
  ctx.shadowBlur = 16;
  ctx.beginPath();
  if (m.type === 'bomb') {
    ctx.arc(x, cy, MOLE_R - 4, 0, Math.PI * 2);
  } else {
    ctx.arc(x, cy, MOLE_R, Math.PI, 0);
    ctx.rect(x - MOLE_R, cy, MOLE_R * 2, MOLE_R);
  }
  ctx.fill();
  ctx.shadowBlur = 0;

  if (m.type === 'bomb') {
    // Fuse and spark.
    ctx.strokeStyle = '#ffb300';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + 10, cy - MOLE_R + 6);
    ctx.quadraticCurveTo(x + 22, cy - MOLE_R - 6, x + 18, cy - MOLE_R - 16);
    ctx.stroke();
    ctx.fillStyle = blink() ? '#ffffff' : '#ff3b3b';
    ctx.shadowColor = '#ff3b3b';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(x + 18, cy - MOLE_R - 17, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ff3b3b';
    ctx.font = `14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('!', x, cy + 8);
  } else {
    // Face: eyes (X when bopped), nose, buck teeth.
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    for (const dx of [-13, 13]) {
      if (hit) {
        ctx.beginPath();
        ctx.moveTo(x + dx - 5, cy - 16);
        ctx.lineTo(x + dx + 5, cy - 6);
        ctx.moveTo(x + dx + 5, cy - 16);
        ctx.lineTo(x + dx - 5, cy - 6);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x + dx, cy - 11, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#05071a';
        ctx.beginPath();
        ctx.arc(x + dx + 1, cy - 10, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
      }
    }
    ctx.fillStyle = '#ff2bd6';
    ctx.beginPath();
    ctx.arc(x, cy + 2, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 6, cy + 9, 5, 8);
    ctx.fillRect(x + 1, cy + 9, 5, 8);
    if (m.type === 'gold') {
      // Crown.
      ctx.fillStyle = '#fff4a3';
      ctx.beginPath();
      ctx.moveTo(x - 16, cy - MOLE_R + 4);
      ctx.lineTo(x - 16, cy - MOLE_R - 12);
      ctx.lineTo(x - 8, cy - MOLE_R - 4);
      ctx.lineTo(x, cy - MOLE_R - 16);
      ctx.lineTo(x + 8, cy - MOLE_R - 4);
      ctx.lineTo(x + 16, cy - MOLE_R - 12);
      ctx.lineTo(x + 16, cy - MOLE_R + 4);
      ctx.fill();
    }
  }
  if (hit && m.type !== 'bomb') {
    // Little stars circling the bopped mole.
    const t = performance.now() / 150;
    ctx.fillStyle = '#ffe600';
    for (let k = 0; k < 3; k++) {
      const a = t + (k * Math.PI * 2) / 3;
      ctx.fillRect(x + Math.cos(a) * 26 - 2, cy - MOLE_R - 4 + Math.sin(a) * 6 - 2, 4, 4);
    }
  }
  ctx.restore();
}

function drawHammer(hm, i) {
  if (!hammerLive(hm)) return;
  const color = HAMMER_COLORS[i];
  const swing = Math.max(0, 1 - (performance.now() - hm.swingAt) / 180); // 1 right after a whack
  ctx.save();
  ctx.translate(hm.x, hm.y - 40);
  ctx.rotate(-0.6 + swing * 1.1 * (i === 0 ? 1 : 1));
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#c9b8ff';
  ctx.fillRect(-4, -10, 8, 62); // handle
  ctx.fillStyle = color;
  ctx.fillRect(-26, -30, 52, 26); // head
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-26, -30, 52, 5);
  ctx.restore();
  // Readiness dot: lit when a squeeze will whack.
  ctx.save();
  ctx.fillStyle = hm.squeeze.armed ? '#c6ff00' : '#55597a';
  ctx.shadowColor = '#c6ff00';
  ctx.shadowBlur = hm.squeeze.armed ? 10 : 0;
  ctx.beginPath();
  ctx.arc(hm.x, hm.y + 24, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawHud() {
  if (state === 'playing' || state === 'paused') {
    glowText(String(score), 16, 48, 22, '#ffffff', 'left');
    glowText('BEST ' + best, 16, 70, 8, '#8fa3ff', 'left');
    glowText(`${Math.ceil(timeLeft)}s`, W - 16, 48, 22, timeLeft < 10 && blink() ? '#ff3b3b' : '#ffe600', 'right');
    const mult = multiplier();
    glowText(mult > 1 ? `×${mult}` : `COMBO ${combo}`, W - 16, 70, 8, mult > 1 ? '#c6ff00' : '#8fa3ff', 'right');
    // Time bar.
    ctx.save();
    ctx.fillStyle = 'rgba(143, 163, 255, 0.2)';
    ctx.fillRect(16, 86, W - 32, 6);
    ctx.fillStyle = timeLeft < 10 ? '#ff3b3b' : '#00e5ff';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 8;
    ctx.fillRect(16, 86, (W - 32) * (timeLeft / ROUND_S), 6);
    ctx.restore();
  }
  if (state === 'start') {
    ctx.fillStyle = 'rgba(6, 10, 31, 0.6)';
    ctx.fillRect(0, 0, W, H);
    glowText('HAND', W / 2, 150, 34, '#ff2bd6');
    glowText('WHACK', W / 2, 198, 34, '#00e5ff');
    glowText('MOVE YOUR PALM TO AIM', W / 2, 270, 10, '#c6ff00');
    glowText('SQUEEZE YOUR HAND TO WHACK', W / 2, 296, 10, '#c6ff00');
    glowText('two hands = two hammers', W / 2, 322, 8, '#8fa3ff');
    glowText('GOLD = +50   BOMB = -5s', W / 2, 360, 9, '#ffd400');
    glowText(`${ROUND_S} SECONDS · COMBOS MULTIPLY`, W / 2, 384, 8, '#8fa3ff');
    if (blink()) glowText('SQUEEZE OR SPACE TO START', W / 2, 440, 10, '#ffffff');
    if (best) glowText('BEST ' + best, W / 2, 476, 9, '#8fa3ff');
  }
  if (state === 'paused') {
    ctx.fillStyle = 'rgba(6, 10, 31, 0.6)';
    ctx.fillRect(0, 0, W, H);
    glowText('PAUSED', W / 2, 290, 24, '#ffe600');
    glowText('P TO RESUME', W / 2, 330, 10, '#ffffff');
  }
  if (state === 'over') {
    ctx.fillStyle = 'rgba(6, 10, 31, 0.65)';
    ctx.fillRect(0, 0, W, H);
    glowText("TIME'S UP", W / 2, 200, 26, '#ff2bd6');
    glowText('SCORE ' + score, W / 2, 260, 14, '#c6ff00');
    glowText(newBest ? 'NEW BEST!' : 'BEST ' + best, W / 2, 292, 10, newBest ? '#ffe600' : '#8fa3ff');
    const total = hits + misses;
    glowText(`HIT ${hits} · MISSED ${misses}${total ? ` · ${Math.round((hits / total) * 100)}%` : ''}`, W / 2, 326, 8, '#8fa3ff');
    if (performance.now() - overAt > RESTART_DELAY_MS && blink()) glowText('SQUEEZE OR SPACE TO RETRY', W / 2, 390, 10, '#ffffff');
  }
}

function draw() {
  ctx.save();
  const now = performance.now();
  if (now < shakeUntil) {
    const k = (shakeUntil - now) / SHAKE_MS;
    ctx.translate((Math.random() - 0.5) * 16 * k, (Math.random() - 0.5) * 16 * k);
  }
  drawBackground();
  for (let i = 0; i < HOLES.length; i++) {
    drawHole(i, false);
    for (const m of moles) if (m.hole === i) drawMole(m);
    drawHole(i, true);
  }
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life * 1.6);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
  }
  ctx.globalAlpha = 1;
  for (const p of popups) {
    ctx.globalAlpha = Math.min(1, p.life * 2);
    glowText(p.text, p.x, p.y, 11, p.color);
  }
  ctx.globalAlpha = 1;
  hammers.forEach(drawHammer);
  drawHud();
  ctx.restore();
}

// ---------- Input ----------
// Top row 1 2 3 = top holes; the numpad uses its own layout (7 8 9 on top).
const DIGIT_HOLES = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, Digit6: 5, Digit7: 6, Digit8: 7, Digit9: 8 };
const NUMPAD_HOLES = { Numpad7: 0, Numpad8: 1, Numpad9: 2, Numpad4: 3, Numpad5: 4, Numpad6: 5, Numpad1: 6, Numpad2: 7, Numpad3: 8 };

window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (e.code === 'Space') e.preventDefault();
  if (e.repeat) return;
  const hole = DIGIT_HOLES[e.code] ?? NUMPAD_HOLES[e.code];
  if (hole !== undefined) return whack(hole, null);
  if (e.code === 'Space' || e.code === 'Enter') startOrRestart();
  if (e.code === 'KeyP') togglePause();
  if (e.code === 'Escape' && state !== 'playing') location.href = './';
  if (e.code === 'KeyD') {
    debugOn = !debugOn;
    debugEl.hidden = !debugOn;
  }
  if (e.code === 'KeyM') soundState.textContent = toggleMute() ? 'OFF' : 'ON';
});

canvas.addEventListener('pointerdown', (e) => {
  unlockAudio();
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * W;
  const y = ((e.clientY - r.top) / r.height) * H;
  if (state !== 'playing') return startOrRestart();
  whack(nearestHole(x, y + 20), null);
});
window.addEventListener('pointerdown', unlockAudio);

// ---------- Hand menu: hover a hand over ARCADE / PLAY on menu screens ----------
const menu = createHandMenu([
  { id: 'arcade', side: 'left', label: '◀ ARCADE', action: () => (location.href = './') },
  {
    id: 'play',
    side: 'right',
    label: 'PLAY ▶',
    action: () => {
      if (state === 'paused') togglePause();
      else if (state === 'start' || state === 'over') startGame();
    },
  },
]);

// ---------- Camera ----------
const STATUS_TEXT = {
  camera: 'Starting camera…',
  loading: 'Loading hand tracker…',
  ready: 'Show your hands to aim',
  'camera-blocked': 'No camera — keyboard / mouse mode',
  'tracker-failed': 'No tracker — keyboard / mouse mode',
};
startTracker(document.getElementById('cam'), (s) => {
  statusEl.textContent = STATUS_TEXT[s];
  if (s === 'ready') trackerReady = true;
  if (s === 'camera-blocked' || s === 'tracker-failed') {
    const msg = document.getElementById('cam-message');
    msg.innerHTML =
      s === 'camera-blocked'
        ? 'CAMERA BLOCKED<br>Keys 1–9 / click still work.<br>Allow the camera and reload to use hands.'
        : 'TRACKER FAILED TO LOAD<br>Check your internet.<br>Keys 1–9 / click still work.';
    msg.hidden = false;
  }
});

// ---------- Loop ----------
let last = performance.now();
let musicOn = false;
renderControls();

function loop(now) {
  const dt = Math.min(now - last, 50);
  last = now;
  if (trackerReady) updateHands();
  update(dt);
  draw();
  menu.setLabel('play', state === 'paused' ? 'RESUME ▶' : state === 'over' ? 'AGAIN ▶' : 'PLAY ▶');
  menu.frame(now, state !== 'playing');

  const wantMusic = state === 'playing';
  if (wantMusic !== musicOn) {
    if (wantMusic) startMusic();
    else stopMusic();
    musicOn = wantMusic;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// For testing in the console.
window.handWhackDebug = { whack, startGame, endGame, get state() { return state; }, get score() { return score; }, get moles() { return moles; }, update, draw, hammers };
