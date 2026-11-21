// hands.js — camera, hand tracking and gesture detection.
// This file only talks to the game through game.js's exported API.
import * as game from './game.js';
import { Vision } from './vision.js';

// =====================================================================
// GESTURE THRESHOLDS — every tunable number lives here.
// Distances are in "palm lengths" (wrist → landmark 9), so they work
// at any distance from the camera.
// =====================================================================
const SINGLE_HAND_MIDLINE = 0.5; // one hand visible: left of this (mirrored) = left hand
// Reference values for curl (avg fingertip→wrist distance):
//   open hand ≈ 1.9, closed fist ≈ 0.9

// --- Move hand: columns ---
const COLUMN_AREA_START = 0.05; // bands start 5% across the mirrored frame…
const COLUMN_AREA_END = 0.47; // …and end at 47% (mirrored to 53–95% when swapped)
const COLUMN_HYSTERESIS = 0.2; // palm must go 0.2 of a column past a boundary to switch

// --- Move hand: fist = soft drop ---
const FIST_ON_CURL = 1.05; // curl below this → soft drop on
const FIST_OFF_CURL = 1.4; // curl above this → soft drop off

// --- Action hand: wrist twist = rotate (anticlockwise only) ---
// Palm facing the camera, turn your hand to the LEFT like a dial: the piece
// rotates 90° anticlockwise. Turning right does nothing. Come back near
// neutral before the next twist counts.
const TWIST_SIGN = 1; // set to -1 if turning LEFT doesn't trigger (and right does)
const TWIST_SMOOTHING = 0.5; // EMA alpha for the knuckle-line angle (1 = no smoothing)
const TWIST_TRIGGER_DEG = 10; // turn this far left of neutral to rotate once
const TWIST_REARM_DEG = 4; // come back within this of neutral to allow the next twist
const NEUTRAL_DRIFT = 0.02; // inside the re-arm zone, neutral moves 2%/frame toward the hand

// --- Thumb + index pinch tap (both hands) ---
// Left hand pinch = rotate clockwise. Right hand pinch = hold.
// A pinch is an "OK sign": thumb + index tips touching while the middle,
// ring and pinky stay straight. A fist curls those three, so the two can't
// be confused. It must also start from an open thumb, so opening out of a
// fist (thumb already against the index) can't fire a pinch.
const PINCH_ON = 0.45; // thumb tip within this of the index tip = pinch
const PINCH_OFF = 0.6; // gap must open above this to arm the next pinch
const PINCH_OTHERS_OUT = 1.15; // AVERAGE of middle, ring + pinky extension must be above this
const PINCH_FIST_CURL = 1.1; // a real fist (curl below this) disarms until the thumb opens again
const PINCH_CONFIRM_FRAMES = 2; // pinch must be seen this many frames in a row

// --- Action hand: fast-movement guard ---
const MOTION_WINDOW_MS = 250; // how much palm-position history we keep
const FAST_MOVE_DISTANCE = 0.5; // palm moved this far within the window → no twists/pinches

// --- Action hand: fist = hard drop (slam) ---
const SLAM_FIST_CURL = 1.05; // curl below this = fist → hard drop
const SLAM_OPEN_CURL = 1.4; // hand must open above this before the next fist counts

// --- Action hand: after a slam or hold ---
const GESTURE_COOLDOWN_MS = 600; // ignore all action-hand gestures this long
const RESTART_DELAY_MS = 1500; // on GAME OVER, wait this long before a fist can restart

// (MediaPipe itself runs in a background worker: see vision.js / vision.worker.js.)

// Landmark pairs that make up the hand skeleton.
const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [9, 10], [10, 11], [11, 12], // middle
  [13, 14], [14, 15], [15, 16], // ring
  [0, 17], [17, 18], [18, 19], [19, 20], // pinky
  [5, 9], [9, 13], [13, 17], // across the palm
];

const MOVE_COLOR = '#00e5ff'; // cyan
const ACTION_COLOR = '#ff2bd6'; // pink

// ---------- State ----------
let video, overlay, octx, statusEl;
let vision = null; // background hand tracker (null until it has loaded)
let swapped = false; // S key: left-handed mode
let aspect = 4 / 3; // video width / height, for aspect-correct distances

// Latest per-role hand data (null when not visible).
let moveHand = null;
let actionHand = null;

// Move-hand gesture state.
let column = null; // board column the palm is over (null = hand not seen)
let fist = false; // soft drop currently on because of a fist
const leftPinch = newPinch(); // pinch detector for the move hand (see pinchTapped)

// Action-hand gesture state.
let twistAngle = null; // smoothed knuckle-line angle in degrees (null = hand not seen)
let neutralAngle = null; // the hand's "resting" angle
let twistDelta = 0; // current angle relative to neutral (negative = turned left)
let twistArmed = true; // false after a twist, until the hand comes back to neutral
const rightPinch = newPinch(); // pinch detector for the action hand
let palmHistory = []; // recent palm-centre positions: { t, x, y }
let handMotion = 0; // biggest palm movement in any direction in the window
let slamArmed = false; // true once the hand has been seen open (re-armed by opening again)
let cooldownUntil = 0; // performance.now() time when the post-gesture cooldown ends
let cooldownText = ''; // 'SLAM!' or 'HOLD!' shown on the camera view during cooldown

// Debug panel (D key).
let debugOn = false;
let debugEl = null;
let columnPos = 0; // palm position measured in columns (before hysteresis)
let delegateUsed = '-'; // 'GPU' or 'CPU'
let fps = 0; // tracking frames per second
let fpsFrames = 0;
let fpsStart = 0;

// ---------- Setup ----------
export async function initHands() {
  video = document.getElementById('cam');
  overlay = document.getElementById('overlay');
  octx = overlay.getContext('2d');
  statusEl = document.getElementById('hand-status');
  debugEl = document.getElementById('debug');

  try {
    setStatus('Starting camera…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: { ideal: 60 }, facingMode: 'user' }, // more fps = less delay
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    aspect = video.videoWidth / video.videoHeight || 4 / 3;
  } catch (err) {
    console.warn('Camera unavailable:', err);
    showCameraMessage('CAMERA BLOCKED<br>Keyboard still works.<br>Allow the camera and reload to use hands.');
    setStatus('No camera — keyboard mode');
    return;
  }

  try {
    setStatus('Loading hand tracker…');
    const v = new Vision(video);
    delegateUsed = await v.load('hand'); // 'GPU', or 'CPU' if the GPU failed
    vision = v;
  } catch (err) {
    console.warn('Hand tracker failed to load:', err);
    showCameraMessage('TRACKER FAILED TO LOAD<br>Check your internet.<br>Keyboard still works.');
    setStatus('No tracker — keyboard mode');
  }
}

export function swapHands() {
  swapped = !swapped;
}

export function isSwapped() {
  return swapped;
}

export function toggleDebug() {
  debugOn = !debugOn;
  debugEl.hidden = !debugOn;
}

// ---------- Raw hand results for other modules (e.g. the hand menu) ----------
const handListeners = [];
// fn receives MediaPipe's raw landmark lists (not mirrored) on every new result.
export function onHands(fn) {
  handListeners.push(fn);
}

// ---------- Per-frame update (called from the game loop) ----------
export function updateHands() {
  if (!vision) return;
  // Detection runs in the background worker; this returns only when a new
  // result has arrived (and sends the next camera frame if the worker is free).
  const landmarks = vision.poll('hand');
  if (!landmarks) return;
  for (const fn of handListeners) fn(landmarks);

  // Count tracking frames per second for the debug panel.
  fpsFrames++;
  if (performance.now() - fpsStart >= 1000) {
    fps = fpsFrames;
    fpsFrames = 0;
    fpsStart = performance.now();
  }
  assignRoles(landmarks);
  updateMoveHand();
  updateActionHand(performance.now());

  drawOverlay();
  updateStatus();
}

// ---------- Roles ----------
// Two hands: the one further LEFT on the mirrored screen is the move hand.
// One hand: the screen midline decides. S swaps the roles.
function assignRoles(hands) {
  const measured = hands.map(measureHand);
  let left = null;
  let right = null;

  if (measured.length >= 2) {
    const [a, b] = measured;
    [left, right] = a.screenX < b.screenX ? [a, b] : [b, a];
  } else if (measured.length === 1) {
    if (measured[0].screenX < SINGLE_HAND_MIDLINE) left = measured[0];
    else right = measured[0];
  }

  moveHand = swapped ? right : left;
  actionHand = swapped ? left : right;
}

// ---------- Move hand: column + soft drop ----------
// Where the column bands sit on the mirrored frame (0..1).
function columnArea() {
  if (!swapped) return { start: COLUMN_AREA_START, end: COLUMN_AREA_END };
  return { start: 1 - COLUMN_AREA_END, end: 1 - COLUMN_AREA_START };
}

function updateMoveHand() {
  if (!moveHand) {
    column = null;
    Object.assign(leftPinch, newPinch());
    if (fist) {
      fist = false;
      game.setSoftDrop(false);
    }
    return;
  }

  // Pinch = rotate clockwise (one rotation per tap).
  if (pinchTapped(leftPinch, moveHand, false)) game.rotate(1);

  // Palm position measured in columns, e.g. 3.6 = 60% of the way across band 3.
  const { start, end } = columnArea();
  const bandWidth = (end - start) / game.COLS;
  const pos = (moveHand.screenX - start) / bandWidth;
  columnPos = pos;
  const clamp = (c) => Math.max(0, Math.min(game.COLS - 1, c));

  // Hysteresis: only switch once the palm is well past the current band's edge.
  // The column is frozen mid-pinch so the tap can't nudge the piece sideways.
  const outsideCurrent =
    column === null || pos < column - COLUMN_HYSTERESIS || pos > column + 1 + COLUMN_HYSTERESIS;
  if (outsideCurrent && !leftPinch.near) {
    const newColumn = clamp(Math.floor(pos));
    if (newColumn !== column) {
      column = newColumn;
      game.moveTo(column); // only on change, so the arrow keys can still nudge
    }
  }

  // Fist = soft drop (two thresholds so it doesn't flicker).
  if (!fist && moveHand.curl < FIST_ON_CURL) {
    fist = true;
    game.setSoftDrop(true);
  } else if (fist && moveHand.curl > FIST_OFF_CURL) {
    fist = false;
    game.setSoftDrop(false);
  }
}

// ---------- Action hand ----------
function updateActionHand(now) {
  if (!actionHand) {
    // Forget everything so the next time the hand appears it starts fresh.
    twistAngle = neutralAngle = null;
    twistDelta = 0;
    twistArmed = true;
    Object.assign(rightPinch, newPinch());
    palmHistory = [];
    handMotion = 0;
    slamArmed = false;
    return;
  }

  updateMotion(actionHand, now);
  const cooling = isCoolingDown(now);
  const moving = handMotion > FAST_MOVE_DISTANCE;

  updateSlam(actionHand, now, cooling);
  if (pinchTapped(rightPinch, actionHand, cooling || moving)) {
    game.hold();
    startCooldown(now, 'HOLD!');
  }
  // Twists don't count during the cooldown, while moving fast, or mid-pinch
  // (so tapping thumb and index can't nudge the dial into a rotation).
  updateTwist(actionHand, cooling || moving || rightPinch.near);
}

function isCoolingDown(now) {
  return now < cooldownUntil;
}

function startCooldown(now, text) {
  cooldownUntil = now + GESTURE_COOLDOWN_MS;
  cooldownText = text;
}

// ---------- Action hand: fast-movement guard ----------
// Tracks how far the palm moved recently, so fast movement can't trigger twists.
function updateMotion(hand, now) {
  const p = hand.pts[9]; // palm centre, aspect-corrected
  palmHistory.push({ t: now, x: p.x, y: p.y });
  while (now - palmHistory[0].t > MOTION_WINDOW_MS) palmHistory.shift();
  handMotion = Math.max(...palmHistory.map((h) => dist(h, p))) / hand.palm;
}

// ---------- Action hand: fist = slam (hard drop) ----------
// Also starts the game from the start screen, or (after a short delay) game over.
function updateSlam(hand, now, cooling) {
  if (hand.curl > SLAM_OPEN_CURL) {
    slamArmed = true; // hand is open: the next fist will count
    return;
  }
  if (!slamArmed || hand.curl >= SLAM_FIST_CURL || cooling) return;

  slamArmed = false; // must open again before the next fist
  const { status, statusTime } = game.getState();
  if (status === 'playing') {
    game.hardDrop();
    startCooldown(now, 'SLAM!');
  } else if (status === 'start' || (status === 'over' && statusTime > RESTART_DELAY_MS)) {
    game.start();
  }
}

// ---------- Pinch tap detector (shared by both hands) ----------
function newPinch() {
  return {
    gap: 0, // thumb tip → index tip (palm lengths)
    others: 0, // average extension of middle, ring + pinky
    othersOut: false, // those fingers are straight enough for an "OK sign"
    near: false, // thumb closing on the index with the other fingers straight
    armed: false, // thumb seen open (gap > PINCH_OFF) since the last pinch or fist
    frames: 0, // consecutive frames that look like a pinch
    down: false, // currently pinched (waiting for the fingers to open again)
  };
}

// Returns true once per pinch tap. blocked = true swallows the tap (cooldown etc.).
function pinchTapped(p, hand, blocked) {
  const f = hand.fingers;
  p.gap = dist(hand.pts[4], hand.pts[8]) / hand.palm;
  p.others = (f.middle + f.ring + f.pinky) / 3;
  p.othersOut = p.others > PINCH_OTHERS_OUT;
  p.near = p.othersOut && p.gap < PINCH_OFF;

  // Thumb clearly open: any pinch is released and the next one is armed.
  if (p.gap > PINCH_OFF) {
    p.down = false;
    p.frames = 0;
    p.armed = true;
    return false;
  }
  // A real fist disarms, so opening out of it (thumb still on the index) can't fire.
  if (hand.curl < PINCH_FIST_CURL) {
    p.armed = false;
    p.frames = 0;
    return false;
  }
  // Curled fingers (a fist forming) aren't an "OK sign".
  if (p.down || !p.armed || !p.othersOut || p.gap >= PINCH_ON) {
    p.frames = 0;
    return false;
  }
  // Looks like a pinch: confirm it over a couple of frames.
  p.frames++;
  if (p.frames < PINCH_CONFIRM_FRAMES) return false;
  p.down = true;
  p.armed = false;
  p.frames = 0;
  return !blocked;
}

// ---------- Action hand: wrist twist = rotate anticlockwise ----------
// Wrap an angle difference into -180..180 so 179° → -179° isn't a 358° jump.
function wrapDeg(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

function updateTwist(hand, suppressed) {
  // Angle of the line from the index knuckle (5) to the pinky knuckle (17).
  const a = hand.pts[5];
  const b = hand.pts[17];
  const raw = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (twistAngle === null) {
    // Hand just appeared: its current angle becomes neutral.
    twistAngle = raw;
    neutralAngle = raw;
  } else {
    twistAngle += TWIST_SMOOTHING * wrapDeg(raw - twistAngle);
  }

  if (suppressed) {
    // Keep neutral glued to the hand, so whatever angle it ends up at
    // becomes the new neutral (no surprise rotation afterwards).
    neutralAngle = twistAngle;
    twistDelta = 0;
    twistArmed = true;
    return;
  }

  // On screen, a negative angle change = the hand turned anticlockwise (left).
  twistDelta = wrapDeg(twistAngle - neutralAngle) * TWIST_SIGN;

  if (Math.abs(twistDelta) <= TWIST_REARM_DEG) {
    // Resting near neutral: re-arm, and let neutral slowly follow the hand.
    twistArmed = true;
    neutralAngle += NEUTRAL_DRIFT * wrapDeg(twistAngle - neutralAngle);
  } else if (twistArmed && twistDelta <= -TWIST_TRIGGER_DEG) {
    twistArmed = false;
    game.rotate(-1); // 90° anticlockwise (turning right is ignored)
  }
}

// ---------- Helper measures ----------
// Turn a raw landmark into mirrored, aspect-corrected screen coordinates.
// x is scaled by the aspect ratio so x and y distances are comparable.
function toScreen(lm) {
  return { x: (1 - lm.x) * aspect, y: lm.y };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Builds everything the gestures need from one hand's 21 landmarks.
function measureHand(landmarks) {
  const pts = landmarks.map(toScreen);
  const palm = dist(pts[0], pts[9]) || 1e-6; // palm length = wrist → landmark 9
  const ext = (tip) => dist(pts[tip], pts[0]) / palm; // fingertip → wrist
  const fingers = {
    index: ext(8),
    middle: ext(12),
    ring: ext(16),
    pinky: ext(20),
  };
  const curl = (fingers.index + fingers.middle + fingers.ring + fingers.pinky) / 4;

  return {
    landmarks, // raw 0..1 values
    pts, // mirrored + aspect-scaled
    palm,
    curl,
    fingers,
    screenX: 1 - landmarks[9].x, // palm centre, mirrored, 0..1 across the frame
    screenY: landmarks[9].y,
  };
}

// ---------- Drawing ----------
function drawOverlay() {
  const w = overlay.width;
  const h = overlay.height;
  octx.clearRect(0, 0, w, h);

  // Faint midline so players can see where the hand areas split.
  octx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  octx.setLineDash([4, 6]);
  octx.beginPath();
  octx.moveTo(w / 2, 0);
  octx.lineTo(w / 2, h);
  octx.stroke();
  octx.setLineDash([]);

  drawColumnBands();

  if (moveHand) drawSkeleton(moveHand, MOVE_COLOR);
  if (actionHand) drawSkeleton(actionHand, ACTION_COLOR);

  drawDial();

  // Big "SLAM!" / "HOLD!" on the action side while the cooldown runs.
  if (isCoolingDown(performance.now())) {
    octx.save();
    octx.font = '16px "Press Start 2P", monospace';
    octx.textAlign = 'center';
    octx.fillStyle = ACTION_COLOR;
    octx.shadowColor = ACTION_COLOR;
    octx.shadowBlur = 12;
    octx.fillText(cooldownText, swapped ? w * 0.25 : w * 0.75, h / 2);
    octx.restore();
  }
}

// Small dial in the action hand's bottom corner. "Up" is neutral, the
// green wedge is the re-arm zone, the pink tick on the left is the
// anticlockwise trigger, and the needle is the hand's current twist.
function drawDial() {
  const r = 26;
  const cx = swapped ? r + 10 : overlay.width - r - 10;
  const cy = overlay.height - r - 10;
  const up = -Math.PI / 2;
  const rad = (deg) => up + (deg * Math.PI) / 180;

  octx.save();
  octx.fillStyle = 'rgba(6, 10, 31, 0.75)';
  octx.beginPath();
  octx.arc(cx, cy, r + 4, 0, Math.PI * 2);
  octx.fill();

  octx.font = '6px "Press Start 2P", monospace';
  octx.textAlign = 'center';

  // Re-arm zone.
  octx.fillStyle = 'rgba(0, 255, 163, 0.3)';
  octx.beginPath();
  octx.moveTo(cx, cy);
  octx.arc(cx, cy, r, rad(-TWIST_REARM_DEG), rad(TWIST_REARM_DEG));
  octx.closePath();
  octx.fill();

  // Dial ring.
  octx.strokeStyle = 'rgba(255, 43, 214, 0.5)';
  octx.lineWidth = 1.5;
  octx.beginPath();
  octx.arc(cx, cy, r, 0, Math.PI * 2);
  octx.stroke();

  // Trigger mark (anticlockwise only, so just the left side).
  octx.strokeStyle = ACTION_COLOR;
  octx.lineWidth = 3;
  const t = rad(-TWIST_TRIGGER_DEG);
  octx.beginPath();
  octx.moveTo(cx + Math.cos(t) * (r - 7), cy + Math.sin(t) * (r - 7));
  octx.lineTo(cx + Math.cos(t) * (r + 3), cy + Math.sin(t) * (r + 3));
  octx.stroke();

  // Needle (grey while waiting to re-arm, hidden when no action hand).
  if (twistAngle !== null) {
    const a = rad(Math.max(-90, Math.min(90, twistDelta)));
    octx.strokeStyle = twistArmed ? '#ffffff' : '#7a7f99';
    octx.lineWidth = 2;
    octx.beginPath();
    octx.moveTo(cx, cy);
    octx.lineTo(cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2));
    octx.stroke();
  }

  octx.fillStyle = ACTION_COLOR;
  octx.fillText('TWIST ↺', cx, cy + r - 4);
  octx.restore();
}

// 10 numbered bands across the move hand's area; the palm's band lights up.
function drawColumnBands() {
  const w = overlay.width;
  const h = overlay.height;
  const { start, end } = columnArea();
  const bandW = ((end - start) * w) / game.COLS;

  octx.save();
  octx.font = '7px "Press Start 2P", monospace';
  octx.textAlign = 'center';
  for (let c = 0; c < game.COLS; c++) {
    const x = start * w + c * bandW;
    if (c === column) {
      octx.fillStyle = fist ? 'rgba(255, 230, 0, 0.3)' : 'rgba(0, 229, 255, 0.25)';
      octx.fillRect(x, 0, bandW, h);
    }
    octx.strokeStyle = 'rgba(0, 229, 255, 0.3)';
    octx.strokeRect(x + 0.5, 0.5, bandW, h - 1);
    octx.fillStyle = c === column ? '#ffffff' : 'rgba(0, 229, 255, 0.7)';
    octx.fillText(String(c + 1), x + bandW / 2, 12);
  }
  octx.restore();
}

function drawSkeleton(hand, color) {
  const w = overlay.width;
  const h = overlay.height;
  const px = (lm) => [(1 - lm.x) * w, lm.y * h]; // mirrored to match the video

  // All bones in one path and all joints in another, so the glow is applied
  // twice per hand instead of 42 times.
  octx.save();
  octx.strokeStyle = color;
  octx.fillStyle = color;
  octx.shadowColor = color;
  octx.shadowBlur = 8;
  octx.lineWidth = 2;
  octx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    const [x1, y1] = px(hand.landmarks[a]);
    const [x2, y2] = px(hand.landmarks[b]);
    octx.moveTo(x1, y1);
    octx.lineTo(x2, y2);
  }
  octx.stroke();
  octx.beginPath();
  for (const lm of hand.landmarks) {
    const [x, y] = px(lm);
    octx.moveTo(x + 3, y);
    octx.arc(x, y, 3, 0, Math.PI * 2);
  }
  octx.fill();
  octx.restore();
}

// ---------- Status text ----------
function updateStatus() {
  const moveSide = swapped ? 'R' : 'L';
  const actionSide = swapped ? 'L' : 'R';
  const line = (name, side, hand, cls, extra) =>
    `<div class="${cls}">${name} (${side}): ${hand ? 'TRACKING · curl ' + hand.curl.toFixed(2) + extra : 'not seen'}</div>`;
  const moveExtra =
    column === null
      ? ''
      : ` · COL ${column + 1}${fist ? ' · FIST' : ''} · PINCH ${leftPinch.gap.toFixed(2)}${leftPinch.down ? ' ✓' : ''}`;
  const now = performance.now();
  const motionNote = isCoolingDown(now) ? ' · COOLDOWN' : handMotion > FAST_MOVE_DISTANCE ? ' · MOVING' : '';
  const actionExtra =
    ` · TWIST ${twistDelta >= 0 ? '+' : ''}${Math.round(twistDelta)}°${twistArmed ? '' : ' (re-arm)'}` +
    ` · PINCH ${rightPinch.gap.toFixed(2)}${rightPinch.down ? ' ✓' : ''}${motionNote}`;
  statusEl.innerHTML =
    line('MOVE', moveSide, moveHand, 'move', moveExtra) +
    line('ACTION', actionSide, actionHand, 'action', actionExtra);

  if (debugOn) renderDebug(now);
}

// D key: every live gesture value next to the threshold it's compared with.
// A row lights up when its gesture is currently "on".
function renderDebug(now) {
  const n = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
  const mv = moveHand;
  const ac = actionHand;
  const f = ac ? ac.fingers : null;
  const cooldownLeft = Math.max(0, cooldownUntil - now);

  const rows = [
    ['TRACKER', `${delegateUsed} · ${fps} fps`, '', false],
    ['— MOVE HAND', '', '', false],
    ['column pos', mv ? n(columnPos) : '—', `±${COLUMN_HYSTERESIS} past edge`, false],
    ['curl (fist)', mv ? n(mv.curl) : '—', `on <${FIST_ON_CURL} · off >${FIST_OFF_CURL}`, fist],
    ['pinch gap', mv ? n(leftPinch.gap) : '—', `rotate <${PINCH_ON} · arm >${PINCH_OFF}`, leftPinch.down],
    ['3 fingers avg', mv ? n(leftPinch.others) : '—', `>${PINCH_OTHERS_OUT} · ${leftPinch.armed ? 'ARMED' : 'open thumb to arm'}`, leftPinch.othersOut],
    ['— ACTION HAND', '', '', false],
    ['twist °', ac ? n(twistDelta, 0) : '—', `≤-${TWIST_TRIGGER_DEG} fire · ±${TWIST_REARM_DEG} re-arm`, !twistArmed],
    ['pinch gap', ac ? n(rightPinch.gap) : '—', `hold <${PINCH_ON} · arm >${PINCH_OFF}`, rightPinch.down],
    ['3 fingers avg', ac ? n(rightPinch.others) : '—', `>${PINCH_OTHERS_OUT} · ${rightPinch.armed ? 'ARMED' : 'open thumb to arm'}`, rightPinch.othersOut],
    ['motion', ac ? n(handMotion) : '—', `>${FAST_MOVE_DISTANCE} in ${MOTION_WINDOW_MS}ms blocks`, handMotion > FAST_MOVE_DISTANCE],
    ['curl (slam)', ac ? n(ac.curl) : '—', `fist <${SLAM_FIST_CURL} · re-open >${SLAM_OPEN_CURL}`, slamArmed],
    ['cooldown ms', n(cooldownLeft, 0), `${GESTURE_COOLDOWN_MS}`, cooldownLeft > 0],
  ];

  debugEl.innerHTML =
    '<table>' +
    rows
      .map(([name, value, threshold, on]) =>
        name.startsWith('—')
          ? `<tr class="head"><td colspan="3">${name}</td></tr>`
          : `<tr class="${on ? 'on' : ''}"><td>${name}</td><td>${value}</td><td>${threshold}</td></tr>`
      )
      .join('') +
    '</table>';
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function showCameraMessage(html) {
  const msg = document.getElementById('cam-message');
  msg.innerHTML = html;
  msg.hidden = false;
}
