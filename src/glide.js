// glide.js — Hand Glide: steer a neon comet through laser gates.
// Three control modes (T cycles):
//   WINGS   — flap your arms like wings; each downstroke flaps (uses body pose tracking)
//   SQUEEZE — squeeze either hand to flap
//   STEER   — the comet follows your palm's height; lose your hand and gravity takes over
// Space / ↑ / click always flap too.
import './style.css';
import { startTracker, detectHands, drawSkeleton, enablePose, isPoseReady, detectPose, drawArms, trackerStats } from './tracker.js';
import { unlockAudio, toggleMute, playEvent, startMusic, stopMusic } from './sound.js';
import { createHandMenu } from './handmenu.js';

// =====================================================================
// TUNING — every gameplay and gesture number lives here.
// =====================================================================
const W = 480; // canvas size
const H = 600;
const FLOOR_Y = 560; // top of the neon floor
const ORB_X = 130; // the comet's fixed x position
const ORB_R = 11; // comet radius
const GRAVITY = 1150; // px/s² (floaty, so hand flaps have time)
const FLAP_VELOCITY = -390; // px/s (negative = up)
const MAX_FALL = 520; // px/s
const GATE_W = 58; // gate thickness
const GATE_SPACING = 240; // horizontal distance between gates
const GAP_START = 195; // opening size at the start…
const GAP_MIN = 135; // …shrinking to this
const GAP_SHRINK = 2.5; // px smaller per gate passed
const SPEED_START = 150; // scroll speed px/s…
const SPEED_MAX = 270; // …up to this
const SPEED_STEP = 4; // px/s faster per gate passed
const MOVING_GATES_FROM = 10; // from this score, some gates slide up and down
const MOVING_GATE_CHANCE = 0.5; // chance a new gate moves
const MOVING_GATE_RANGE = 45; // px the gap slides each way
const RESTART_DELAY_MS = 800; // after a crash, wait this long before a flap restarts
const SHAKE_MS = 350; // screen shake after a crash

// WINGS mode: arm height = how far your wrists are above your shoulders, in
// shoulder-widths (so it works at any distance). A flap is a DOWNSTROKE: arm
// height dropping from its recent high; raising your arms again re-arms it.
const WING_DROP = 0.45; // arms fall this far (shoulder-widths) below their recent high → flap
const WING_RISE = 0.3; // arms rise this far above their recent low → ready again
const POSE_VISIBLE = 0.5; // a shoulder / wrist counts as seen above this visibility

// SQUEEZE mode: curl = avg fingertip→wrist distance in palm lengths. A flap is
// curl dropping from its recent high, so quick half-squeezes count.
const SQUEEZE_DROP = 0.35; // curl falls this much below its recent high → flap
const REOPEN_RISE = 0.2; // curl rises this much above its recent low → ready again

// STEER mode: palm height in the camera frame (0 = top, 1 = bottom) → comet height.
const STEER_TOP = 0.2; // palm this high in the frame = top of the sky
const STEER_BOTTOM = 0.75; // palm this low = just above the floor
const STEER_RESPONSE = 12; // how quickly the comet follows (per second)
const HAND_LOST_MS = 250; // no hand for this long → gravity takes over

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
const debugEl = document.getElementById('debug');
const controlsEl = document.getElementById('controls');

// ---------- State ----------
const MODES = ['wings', 'squeeze', 'steer'];
let mode = 'wings';
let state = 'start'; // 'start' | 'playing' | 'paused' | 'over'
let overAt = 0;
let y = H / 2;
let vy = 0;
let gates = []; // { x, baseTop, gapTop, gap, color, passed, moving, phase }
let trail = []; // recent comet positions
let particles = []; // crash sparks
let popups = []; // floating "+1"s
let score = 0;
const best = Object.fromEntries(MODES.map((m) => [m, loadBest(m)]));
let scroll = 0; // background scroll distance
let clock = 0; // seconds of play, drives moving gates
let shakeUntil = 0;
let flashUntil = 0; // "FLAP!" on the camera view
let debugOn = false;

// Tracking state.
let trackerReady = false;
let latestHands = [];
let latestPose = null; // { landmarks, pts } or null when nobody is in view
let armsHeight = null; // wrists above shoulders, in shoulder-widths
let wing = newDetector(); // downstroke detector for WINGS mode
// Per screen side: squeeze detectors for SQUEEZE mode — see updateDetector().
const sides = { left: newDetector(), right: newDetector() };
let steerHand = null; // the hand currently steering (STEER mode)
let steerPalmY = null; // palm height (0..1) of the steering hand
let lastHandSeen = -Infinity;
let fps = 0;
let fpsFrames = 0;
let fpsStart = 0;

// ---------- Game control ----------
function startGame() {
  state = 'playing';
  y = H / 2;
  vy = mode === 'steer' ? 0 : FLAP_VELOCITY;
  gates = [];
  trail = [];
  particles = [];
  popups = [];
  score = 0;
  clock = 0;
  playEvent('start');
}

function flap() {
  if (state === 'start') return startGame();
  if (state === 'over') {
    if (performance.now() - overAt > RESTART_DELAY_MS) startGame();
    return;
  }
  if (state !== 'playing' || isSteering()) return; // while steering, the hand is in charge
  vy = FLAP_VELOCITY;
  playEvent('flap');
}

function crash() {
  state = 'over';
  overAt = performance.now();
  shakeUntil = overAt + SHAKE_MS;
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 80 + Math.random() * 260;
    particles.push({ x: ORB_X, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, color: COLORS[i % 4] });
  }
  if (score > best[mode]) {
    best[mode] = score;
    saveBest(mode, score);
  }
  playEvent('crash');
}

function togglePause() {
  if (state === 'playing') state = 'paused';
  else if (state === 'paused') state = 'playing';
}

function toggleMode() {
  if (state === 'playing' || state === 'paused') return; // switch between games only
  mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  if (mode === 'wings') enablePose();
  renderControls();
}

// Steering only while a hand has been seen very recently.
function isSteering() {
  return mode === 'steer' && performance.now() - lastHandSeen < HAND_LOST_MS && steerPalmY !== null;
}

// Best scores are a per-browser convenience; the game works without storage.
// The squeeze mode keeps the original key so earlier best scores carry over.
function bestKey(m) {
  return m === 'squeeze' ? 'handglide-best' : `handglide-best-${m}`;
}

function loadBest(m) {
  try {
    return Number(localStorage.getItem(bestKey(m))) || 0;
  } catch {
    return 0;
  }
}

function saveBest(m, v) {
  try {
    localStorage.setItem(bestKey(m), String(v));
  } catch {
    /* storage unavailable: best score just isn't kept */
  }
}

// ---------- Update ----------
function update(dt) {
  const speed = Math.min(SPEED_MAX, SPEED_START + score * SPEED_STEP);
  scroll += (state === 'playing' ? speed : 60) * dt;

  // Sparks and popups keep moving in every state.
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 600 * dt;
    p.life -= dt * 1.2;
  }
  particles = particles.filter((p) => p.life > 0);
  for (const p of popups) {
    p.y -= 40 * dt;
    p.life -= dt * 1.5;
  }
  popups = popups.filter((p) => p.life > 0);

  if (state === 'start') {
    y = H / 2 + Math.sin(performance.now() / 300) * 14; // idle bob
    return;
  }
  if (state !== 'playing') return;
  clock += dt;

  // Comet: follow the palm while steering, otherwise gravity + flaps.
  if (isSteering()) {
    const t = (steerPalmY - STEER_TOP) / (STEER_BOTTOM - STEER_TOP);
    const target = ORB_R + 4 + Math.max(0, Math.min(1, t)) * (FLOOR_Y - 2 * ORB_R - 8);
    const prev = y;
    y += (target - y) * Math.min(1, STEER_RESPONSE * dt);
    vy = (y - prev) / dt; // keeps the fall smooth if the hand is lost
  } else {
    vy = Math.min(MAX_FALL, vy + GRAVITY * dt);
    y += vy * dt;
  }
  trail.forEach((t) => (t.x -= speed * dt));
  trail.push({ x: ORB_X, y });
  if (trail.length > 14) trail.shift();

  // Move, spawn and score gates.
  for (const g of gates) {
    g.x -= speed * dt;
    if (g.moving) {
      const lo = 40;
      const hi = FLOOR_Y - 40 - g.gap;
      g.gapTop = Math.max(lo, Math.min(hi, g.baseTop + Math.sin(clock * 1.6 + g.phase) * MOVING_GATE_RANGE));
    }
  }
  gates = gates.filter((g) => g.x > -GATE_W - 10);
  const last = gates[gates.length - 1];
  if (!last || last.x < W - GATE_SPACING) spawnGate();

  for (const g of gates) {
    if (!g.passed && g.x + GATE_W < ORB_X - ORB_R) {
      g.passed = true;
      score++;
      popups.push({ x: ORB_X + 20, y: y - 20, life: 1 });
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

function spawnGate() {
  const gap = Math.max(GAP_MIN, GAP_START - score * GAP_SHRINK);
  const moving = score >= MOVING_GATES_FROM && Math.random() < MOVING_GATE_CHANCE;
  const margin = moving ? 40 + MOVING_GATE_RANGE : 50;
  const baseTop = margin + Math.random() * (FLOOR_Y - 2 * margin - gap);
  gates.push({
    x: W + 10,
    baseTop,
    gapTop: baseTop,
    gap,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    passed: false,
    moving,
    phase: Math.random() * Math.PI * 2,
  });
}

// Circle (the comet) vs rectangle, using the closest point on the rectangle.
function hitsRect(rx, ry, rw, rh) {
  const cx = Math.max(rx, Math.min(ORB_X, rx + rw));
  const cy = Math.max(ry, Math.min(y, ry + rh));
  return Math.hypot(ORB_X - cx, y - cy) < ORB_R;
}

// ---------- Tracking ----------
// WINGS mode runs the body-pose model; the other modes run the hand model.
function updateTracking() {
  if (mode === 'wings') updatePose();
  else updateHands();
}

function countFps(now) {
  fpsFrames++;
  if (now - fpsStart >= 1000) {
    fps = fpsFrames;
    fpsFrames = 0;
    fpsStart = now;
  }
}

// ---------- WINGS: arm flapping ----------
function updatePose() {
  if (trackerReady && !isPoseReady()) {
    statusEl.textContent = 'Loading arm tracker…';
    return;
  }
  const pose = detectPose();
  if (pose === null) return; // no new camera frame
  const now = performance.now();
  countFps(now);
  latestPose = pose.landmarks ? pose : null;
  // Wrists drive the menu cursors in WINGS mode.
  menu.feed(latestPose ? [15, 16].filter((i) => (pose.landmarks[i].visibility ?? 1) > 0.5).map((i) => ({ x: 1 - pose.landmarks[i].x, y: pose.landmarks[i].y })) : []);

  // Arm height: wrists above the shoulder line, in shoulder-widths.
  armsHeight = null;
  if (latestPose) {
    const p = latestPose.pts;
    const seen = (i) => p[i].visibility > POSE_VISIBLE;
    const shoulderW = dist(p[11], p[12]);
    const wrists = [15, 16].filter(seen);
    if (seen(11) && seen(12) && shoulderW > 0.02 && wrists.length) {
      const shoulderY = (p[11].y + p[12].y) / 2;
      const wristY = wrists.reduce((sum, i) => sum + p[i].y, 0) / wrists.length;
      armsHeight = (shoulderY - wristY) / shoulderW;
    }
  }

  if (armsHeight === null) {
    wing = newDetector(); // start fresh when the arms come back into view
  } else if (updateDetector(wing, armsHeight, WING_DROP, WING_RISE)) {
    flashUntil = now + 220;
    flap();
  }

  drawOverlay();
  statusEl.innerHTML =
    armsHeight === null
      ? `<div class="move">ARMS: not seen — step back so your shoulders and hands are in view</div>`
      : `<div class="move">ARMS: TRACKING · height ${armsHeight >= 0 ? '+' : ''}${armsHeight.toFixed(2)}${wing.armed ? ' · READY' : ''}</div>`;
  statusEl.innerHTML += `<div class="mode">MODE: WINGS (T to switch)</div>`;
  if (debugOn) renderDebug(now);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------- SQUEEZE + STEER: hands ----------
function updateHands() {
  const hands = detectHands();
  if (!hands) return; // no new camera frame
  latestHands = hands;
  menu.feed(hands.map((h) => ({ x: h.screenX, y: h.landmarks[9].y })));
  const now = performance.now();
  countFps(now);

  // STEER: follow the hand nearest to where the steering palm just was, so the
  // comet doesn't jump if a second hand appears (MediaPipe's order can swap).
  if (hands.length) {
    const prev = steerPalmY ?? 0.5;
    steerHand = hands.reduce((a, b) =>
      Math.abs(b.landmarks[9].y - prev) < Math.abs(a.landmarks[9].y - prev) ? b : a
    );
    lastHandSeen = now;
    steerPalmY = steerHand.landmarks[9].y;
  } else {
    steerHand = null;
  }

  // Squeezes: flap in SQUEEZE mode; in STEER mode a squeeze starts / restarts the game.
  const bySide = { left: null, right: null };
  for (const h of hands) bySide[h.screenX < 0.5 ? 'left' : 'right'] = h;
  for (const side of ['left', 'right']) {
    const h = bySide[side];
    if (!h) {
      sides[side] = newDetector(); // forget this side until a hand shows up again
      continue;
    }
    if (updateDetector(sides[side], h.curl, SQUEEZE_DROP, REOPEN_RISE) && (mode === 'squeeze' || state !== 'playing')) {
      flashUntil = now + 220;
      flap();
    }
  }

  drawOverlay();
  const line = (side, cls) => {
    const h = bySide[side];
    return `<div class="${cls}">${side.toUpperCase()}: ${h ? 'TRACKING · curl ' + h.curl.toFixed(2) + (sides[side].armed ? ' · READY' : '') : 'not seen'}</div>`;
  };
  statusEl.innerHTML =
    line('left', 'move') + line('right', 'action') + `<div class="mode">MODE: ${mode.toUpperCase()} (T to switch)</div>`;
  if (debugOn) renderDebug(now);
}

// ---------- Drop detector (wing downstrokes and hand squeezes) ----------
function newDetector() {
  return { armed: false, value: null, high: null, low: null };
}

// Returns true once per "drop". While armed it tracks the highest value seen;
// falling `drop` below that = flap. Then it tracks the lowest value, and
// re-arms once the value climbs `rise` above it. Used for arm height (WINGS)
// and hand curl (SQUEEZE), so partial strokes count and jitter doesn't.
function updateDetector(s, value, drop, rise) {
  s.value = value;
  if (s.high === null) {
    // Just appeared: ready straight away, measured from where it is now.
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

function drawOverlay() {
  const w = overlay.width;
  const h = overlay.height;
  octx.clearRect(0, 0, w, h);

  if (mode === 'steer') {
    // The palm-height range that maps onto the sky, and where the palm is now.
    octx.save();
    octx.fillStyle = 'rgba(198, 255, 0, 0.08)';
    octx.fillRect(0, STEER_TOP * h, w, (STEER_BOTTOM - STEER_TOP) * h);
    octx.strokeStyle = 'rgba(198, 255, 0, 0.5)';
    octx.setLineDash([4, 6]);
    octx.strokeRect(0.5, STEER_TOP * h, w - 1, (STEER_BOTTOM - STEER_TOP) * h);
    octx.setLineDash([]);
    if (steerHand) {
      const py = steerHand.landmarks[9].y * h;
      octx.strokeStyle = '#c6ff00';
      octx.shadowColor = '#c6ff00';
      octx.shadowBlur = 8;
      octx.lineWidth = 2;
      octx.beginPath();
      octx.moveTo(0, py);
      octx.lineTo(w, py);
      octx.stroke();
    }
    octx.restore();
  }

  if (mode === 'wings') {
    if (latestPose) drawArms(octx, latestPose, wing.armed ? '#c6ff00' : '#ff2bd6');
    if (armsHeight === null) {
      octx.save();
      octx.font = `8px ${FONT}`;
      octx.textAlign = 'center';
      octx.fillStyle = '#ffe600';
      octx.fillText('STEP BACK: SHOULDERS', w / 2, h - 30);
      octx.fillText('AND HANDS IN VIEW', w / 2, h - 16);
      octx.restore();
    }
  } else {
    for (const hand of latestHands) drawSkeleton(octx, hand, hand.screenX < 0.5 ? '#00e5ff' : '#ff2bd6');
  }

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

// Debug text: how far the value has dropped (armed) or climbed back (re-arming).
function dropInfo(s, drop, rise) {
  if (s.value === null) return `drop ${drop} · rise ${rise}`;
  return s.armed ? `drop ${(s.high - s.value).toFixed(2)} / ${drop}` : `rise ${(s.value - s.low).toFixed(2)} / ${rise}`;
}

// D key: live tracking values next to their thresholds.
function renderDebug() {
  const n = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
  const rows =
    mode === 'wings'
      ? [
          ['TRACKER', `pose · ${fps} fps`, trackerStats() ? `${trackerStats().detectMs.toFixed(0)} ms detect · ${trackerStats().latencyMs.toFixed(0)} ms delay` : '', false],
          ['mode', 'WINGS', 'T to switch', false],
          ['arms height', n(armsHeight), 'above shoulders (widths)', armsHeight !== null],
          ['downstroke', armsHeight === null ? '—' : wing.armed ? 'READY' : 'raise arms', dropInfo(wing, WING_DROP, WING_RISE), wing.armed],
          ['comet y', n(y, 0), `0 → ${FLOOR_Y}`, false],
        ]
      : [
          ['TRACKER', `hands · ${fps} fps · ${latestHands.length} seen`, trackerStats() ? `${trackerStats().detectMs.toFixed(0)} ms detect · ${trackerStats().latencyMs.toFixed(0)} ms delay` : '', false],
          ['mode', mode.toUpperCase(), 'T to switch', false],
          ['left curl', n(sides.left.value), dropInfo(sides.left, SQUEEZE_DROP, REOPEN_RISE), sides.left.armed],
          ['right curl', n(sides.right.value), dropInfo(sides.right, SQUEEZE_DROP, REOPEN_RISE), sides.right.armed],
          ['palm height', n(steerPalmY), `${STEER_TOP} top → ${STEER_BOTTOM} floor`, isSteering()],
          ['comet y', n(y, 0), `0 → ${FLOOR_Y}`, false],
        ];
  debugEl.innerHTML =
    '<table>' +
    rows
      .map(([name, value, threshold, on]) => `<tr class="${on ? 'on' : ''}"><td>${name}</td><td>${value}</td><td>${threshold}</td></tr>`)
      .join('') +
    '</table>';
}

function renderControls() {
  const panels = {
    wings: `<div class="ctl-col move"><b>WINGS MODE</b><span>FLAP YOUR ARMS · FLAP</span><span>STAND BACK FROM CAMERA</span></div>
            <div class="ctl-col action"><b>GOAL</b><span>FLY THROUGH GAPS</span><span>T · NEXT MODE</span></div>`,
    squeeze: `<div class="ctl-col move"><b>SQUEEZE MODE</b><span>SQUEEZE HAND · FLAP</span><span>EITHER HAND WORKS</span></div>
              <div class="ctl-col action"><b>GOAL</b><span>FLY THROUGH GAPS</span><span>T · NEXT MODE</span></div>`,
    steer: `<div class="ctl-col move"><b>STEER MODE</b><span>RAISE HAND · GO UP</span><span>LOWER HAND · GO DOWN</span></div>
            <div class="ctl-col action"><b>GOAL</b><span>KEEP HAND IN VIEW</span><span>T · NEXT MODE</span></div>`,
  };
  controlsEl.innerHTML = panels[mode];
}

// ---------- Drawing ----------
function draw() {
  ctx.save();
  if (performance.now() < shakeUntil) {
    const k = (shakeUntil - performance.now()) / SHAKE_MS;
    ctx.translate((Math.random() - 0.5) * 14 * k, (Math.random() - 0.5) * 14 * k);
  }

  // Sky.
  const sky = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
  sky.addColorStop(0, '#060a1f');
  sky.addColorStop(1, '#1a1050');
  ctx.fillStyle = sky;
  ctx.fillRect(-10, -10, W + 20, H + 20);

  drawStars();
  drawSun();
  drawFloor();
  gates.forEach(drawGate);
  drawComet();
  drawParticles();
  drawPopups();
  ctx.restore();

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
  ctx.fillRect(-10, FLOOR_Y, W + 20, H - FLOOR_Y + 10);
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
  // Moving gates show little arrows in the gap.
  if (g.moving) {
    ctx.fillStyle = g.color;
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('↕', g.x + GATE_W / 2, g.gapTop + g.gap / 2 + 4);
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

function drawPopups() {
  ctx.save();
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = 'center';
  for (const p of popups) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = '#c6ff00';
    ctx.fillText('+1', p.x, p.y);
  }
  ctx.restore();
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
    glowText('BEST ' + best[mode], W / 2, 96, 9, '#8fa3ff');
    ctx.save();
    ctx.font = `7px ${FONT}`;
    ctx.fillStyle = mode === 'steer' ? '#c6ff00' : '#8fa3ff';
    const label = { wings: 'WINGS', squeeze: 'SQUEEZE' }[mode] || (isSteering() ? 'STEER ✋' : 'STEER · HAND LOST!');
    ctx.fillText(label, 12, H - 14);
    ctx.restore();
  }
  if (state === 'start') {
    glowText('HAND', W / 2, 170, 34, '#ff2bd6');
    glowText('GLIDE', W / 2, 218, 34, '#00e5ff');
    glowText(`◀ ${mode.toUpperCase()} MODE ▶`, W / 2, 330, 10, '#ffe600');
    const howTo = {
      wings: ['FLAP YOUR ARMS LIKE WINGS', 'stand back: shoulders + hands in view'],
      squeeze: ['SQUEEZE YOUR HAND TO FLAP', 'quick half-squeezes work'],
      steer: ['RAISE / LOWER YOUR HAND', 'the comet follows your palm'],
    }[mode];
    glowText(howTo[0], W / 2, 362, 10, '#c6ff00');
    glowText(howTo[1], W / 2, 384, 8, '#8fa3ff');
    glowText('T to switch mode', W / 2, 404, 8, '#8fa3ff');
    if (blink()) glowText(mode === 'wings' ? 'FLAP OR SPACE TO START' : 'SQUEEZE OR SPACE TO START', W / 2, 444, 10, '#ffffff');
    if (best[mode]) glowText('BEST ' + best[mode], W / 2, 480, 9, '#8fa3ff');
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
    glowText('BEST ' + best[mode], W / 2, 308, 10, '#8fa3ff');
    if (blink() && performance.now() - overAt > RESTART_DELAY_MS) {
      glowText(mode === 'wings' ? 'FLAP OR SPACE TO RETRY' : 'SQUEEZE OR SPACE TO RETRY', W / 2, 380, 10, '#ffffff');
    }
    glowText('T to switch mode', W / 2, 410, 8, '#8fa3ff');
  }
}

// ---------- Input ----------
window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (['Space', 'ArrowUp'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (['Space', 'ArrowUp', 'KeyW', 'Enter'].includes(e.code)) flap();
  if (e.code === 'KeyP') togglePause();
  if (e.code === 'Escape' && state !== 'playing') location.href = './';
  if (e.code === 'KeyT') toggleMode();
  if (e.code === 'KeyD') {
    debugOn = !debugOn;
    debugEl.hidden = !debugOn;
  }
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
  ready: 'Show a hand to play',
  'camera-blocked': 'No camera — keyboard mode',
  'tracker-failed': 'No tracker — keyboard mode',
};
enablePose(); // WINGS is the default mode, so load the arm tracker up front
startTracker(document.getElementById('cam'), (s) => {
  statusEl.textContent = STATUS_TEXT[s];
  if (s === 'ready') trackerReady = true;
  if (s === 'camera-blocked' || s === 'tracker-failed') {
    const msg = document.getElementById('cam-message');
    msg.innerHTML =
      s === 'camera-blocked'
        ? 'CAMERA BLOCKED<br>Space / click still work.<br>Allow the camera and reload to use hands.'
        : 'TRACKER FAILED TO LOAD<br>Check your internet.<br>Space / click still work.';
    msg.hidden = false;
  }
});

// ---------- Hand menu: hover a hand (or wrist) over ARCADE / PLAY on menu screens ----------
const menu = createHandMenu([
  { id: 'arcade', side: 'left', label: '◀ ARCADE', action: () => (location.href = './') },
  {
    id: 'play',
    side: 'right',
    label: 'PLAY ▶',
    action: () => {
      unlockAudio();
      if (state === 'paused') togglePause();
      else if (state === 'start' || state === 'over') startGame();
    },
  },
]);

// ---------- Loop ----------
let last = performance.now();
let musicOn = false;
renderControls();

function loop(now) {
  const dt = Math.min(now - last, 50) / 1000; // seconds, clamped
  last = now;
  updateTracking();
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
