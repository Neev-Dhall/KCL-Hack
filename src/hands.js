// hands.js — camera, hand tracking and gesture detection.
// This file only talks to the game through game.js's exported API.
import * as game from './game.js';

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

// --- Action hand: wrist twist = rotate ---
const TWIST_SIGN = 1; // set to -1 if twisting rotates the wrong way
const TWIST_SMOOTHING = 0.5; // EMA alpha for the knuckle-line angle (1 = no smoothing)
const TWIST_TRIGGER_DEG = 35; // turn this far from neutral to rotate once
const TWIST_REARM_DEG = 15; // come back within this to allow the next twist
const NEUTRAL_DRIFT = 0.02; // inside the re-arm zone, neutral moves 2%/frame toward the hand

// --- Action hand: pinch backup mode (T key) ---
const PINCH_ON = 0.45; // thumb tip within this of index tip (↻) or middle tip (↺)
const PINCH_OFF = 0.6; // released once the gap is above this
const PINKY_OPEN = 1.0; // pinky tip must be this far from the wrist for a pinch to count

// --- Action hand: fast downward swipe = slam (hard drop) ---
const SLAM_WINDOW_MS = 220; // how much palm-position history we keep
const SLAM_DISTANCE = 1.2; // palm moves this far DOWN within the window → slam
const SLAM_COOLDOWN_MS = 600; // after a slam, ignore all action-hand gestures this long
const FAST_MOVE_DISTANCE = 0.5; // hand moved this far within the window → no twists/grabs

// --- Action hand: quick grab (open → fist) = hold ---
const GRAB_OPEN_CURL = 1.4; // curl above this counts as an open hand
const GRAB_CLOSED_CURL = 1.05; // curl below this counts as a fist
const GRAB_MAX_MS = 300; // open → fist must happen within this time
const RESTART_GRAB_DELAY_MS = 1500; // on GAME OVER, wait this long before a grab can restart

// ---------- MediaPipe setup ----------
const MEDIAPIPE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const WASM_URL = MEDIAPIPE_URL + '/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

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
let landmarker = null;
let lastVideoTime = -1;
let swapped = false; // S key: left-handed mode
let aspect = 4 / 3; // video width / height, for aspect-correct distances

// Latest per-role hand data (null when not visible).
let moveHand = null;
let actionHand = null;

// Move-hand gesture state.
let column = null; // board column the palm is over (null = hand not seen)
let fist = false; // soft drop currently on because of a fist

// Action-hand gesture state.
let twistMode = true; // T key toggles: true = wrist twist, false = pinch
let twistAngle = null; // smoothed knuckle-line angle in degrees (null = hand not seen)
let neutralAngle = null; // the hand's "resting" angle
let twistDelta = 0; // current angle relative to neutral
let twistArmed = true; // false after a twist, until the hand comes back to neutral
let pinchCW = false; // thumb+index currently pinched
let pinchCCW = false; // thumb+middle currently pinched
let pinchIndexGap = 0; // latest pinch distances (shown in the status / debug)
let pinchMiddleGap = 0;
let palmHistory = []; // recent palm-centre positions: { t, x, y }
let slamDrop = 0; // how far the palm fell within the window (palm lengths)
let handMotion = 0; // how far the palm moved within the window (palm lengths)
let cooldownUntil = 0; // performance.now() time when the post-slam cooldown ends
let grabArmed = false; // true once the hand has been seen open (re-armed by opening again)
let lastOpenTime = 0; // last time the action hand was fully open

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
      video: { width: 640, height: 480, facingMode: 'user' },
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
    const { FilesetResolver, HandLandmarker } = await import(/* @vite-ignore */ MEDIAPIPE_URL);
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
    });
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
      delegateUsed = 'GPU';
    } catch (gpuErr) {
      console.warn('GPU delegate failed, using CPU:', gpuErr);
      landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
      delegateUsed = 'CPU';
    }
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

export function toggleTwistMode() {
  twistMode = !twistMode;
  pinchCW = pinchCCW = false;
  twistArmed = true;
}

// ---------- Per-frame update (called from the game loop) ----------
export function updateHands() {
  if (!landmarker || video.readyState < 2) return;

  // Only run detection once per new video frame.
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const result = landmarker.detectForVideo(video, performance.now());

  // Count tracking frames per second for the debug panel.
  fpsFrames++;
  if (performance.now() - fpsStart >= 1000) {
    fps = fpsFrames;
    fpsFrames = 0;
    fpsStart = performance.now();
  }
  assignRoles(result.landmarks || []);
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
    if (fist) {
      fist = false;
      game.setSoftDrop(false);
    }
    return;
  }

  // Palm position measured in columns, e.g. 3.6 = 60% of the way across band 3.
  const { start, end } = columnArea();
  const bandWidth = (end - start) / game.COLS;
  const pos = (moveHand.screenX - start) / bandWidth;
  columnPos = pos;
  const clamp = (c) => Math.max(0, Math.min(game.COLS - 1, c));

  // Hysteresis: only switch once the palm is well past the current band's edge.
  const outsideCurrent =
    column === null || pos < column - COLUMN_HYSTERESIS || pos > column + 1 + COLUMN_HYSTERESIS;
  if (outsideCurrent) {
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
    pinchCW = pinchCCW = false;
    palmHistory = [];
    slamDrop = handMotion = 0;
    grabArmed = false;
    return;
  }

  updateSlam(actionHand, now);

  // During the post-slam cooldown, or while the hand is moving fast,
  // twists, pinches and grabs don't count.
  const suppressed = isCoolingDown(now) || handMotion > FAST_MOVE_DISTANCE;
  if (twistMode) updateTwist(actionHand, suppressed);
  else updatePinch(actionHand, suppressed);
  updateGrab(actionHand, now, suppressed);
}

// ---------- Action hand: grab ----------
// A quick close from open hand to fist = hold the piece.
function updateGrab(hand, now, suppressed) {
  if (hand.curl > GRAB_OPEN_CURL) {
    grabArmed = true;
    lastOpenTime = now;
    return;
  }
  if (grabArmed && hand.curl < GRAB_CLOSED_CURL) {
    grabArmed = false; // must open again before the next grab
    const quick = now - lastOpenTime <= GRAB_MAX_MS;
    if (quick && !suppressed) onGrab();
  }
}

// A grab holds the piece while playing, and starts the game from the
// start screen or (after a short delay) the game-over screen.
function onGrab() {
  const { status, statusTime } = game.getState();
  if (status === 'playing') game.hold();
  else if (status === 'start') game.start();
  else if (status === 'over' && statusTime > RESTART_GRAB_DELAY_MS) game.start();
}

function isCoolingDown(now) {
  return now < cooldownUntil;
}

// ---------- Action hand: slam ----------
function updateSlam(hand, now) {
  const p = hand.pts[9]; // palm centre, aspect-corrected
  palmHistory.push({ t: now, x: p.x, y: p.y });
  while (now - palmHistory[0].t > SLAM_WINDOW_MS) palmHistory.shift();

  // Downward distance from the highest point in the window (y grows downward).
  const highestY = Math.min(...palmHistory.map((h) => h.y));
  slamDrop = (p.y - highestY) / hand.palm;
  // Biggest distance between now and anywhere the palm was in the window.
  handMotion = Math.max(...palmHistory.map((h) => dist(h, p))) / hand.palm;

  if (isCoolingDown(now)) return;
  if (slamDrop >= SLAM_DISTANCE) {
    game.hardDrop();
    cooldownUntil = now + SLAM_COOLDOWN_MS;
    palmHistory = [palmHistory[palmHistory.length - 1]]; // start fresh after the slam
  }
}

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
    // Keep neutral glued to the hand, so whatever angle the hand ends up at
    // after a swipe becomes the new neutral (no surprise rotation).
    neutralAngle = twistAngle;
    twistDelta = 0;
    twistArmed = true;
    return;
  }

  twistDelta = wrapDeg(twistAngle - neutralAngle) * TWIST_SIGN;

  if (Math.abs(twistDelta) <= TWIST_REARM_DEG) {
    // Resting near neutral: re-arm, and let neutral slowly follow the hand.
    twistArmed = true;
    neutralAngle += NEUTRAL_DRIFT * wrapDeg(twistAngle - neutralAngle);
  } else if (twistArmed && twistDelta >= TWIST_TRIGGER_DEG) {
    twistArmed = false;
    game.rotate(1); // clockwise
  } else if (twistArmed && twistDelta <= -TWIST_TRIGGER_DEG) {
    twistArmed = false;
    game.rotate(-1); // anticlockwise
  }
}

function updatePinch(hand, suppressed) {
  const p = hand.pts;
  pinchIndexGap = dist(p[4], p[8]) / hand.palm;
  pinchMiddleGap = dist(p[4], p[12]) / hand.palm;
  const pinkyOpen = dist(p[20], p[0]) / hand.palm > PINKY_OPEN;

  // Release first (always allowed), then look for a new pinch.
  if (pinchCW && pinchIndexGap > PINCH_OFF) pinchCW = false;
  if (pinchCCW && pinchMiddleGap > PINCH_OFF) pinchCCW = false;
  if (suppressed || !pinkyOpen) return; // no new pinches while swiping or making a fist

  if (!pinchCW && !pinchCCW && pinchIndexGap < PINCH_ON) {
    pinchCW = true;
    game.rotate(1);
  } else if (!pinchCW && !pinchCCW && pinchMiddleGap < PINCH_ON) {
    pinchCCW = true;
    game.rotate(-1);
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

// Builds everything later phases need from one hand's 21 landmarks.
function measureHand(landmarks) {
  const pts = landmarks.map(toScreen);
  const palm = dist(pts[0], pts[9]) || 1e-6; // palm length = wrist → landmark 9
  const tips = [8, 12, 16, 20];
  const curl = tips.reduce((sum, i) => sum + dist(pts[i], pts[0]), 0) / tips.length / palm;

  return {
    landmarks, // raw 0..1 values
    pts, // mirrored + aspect-scaled
    palm,
    curl,
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

  // Big "SLAM" on the action side while the cooldown runs.
  if (isCoolingDown(performance.now())) {
    octx.save();
    octx.font = '16px "Press Start 2P", monospace';
    octx.textAlign = 'center';
    octx.fillStyle = ACTION_COLOR;
    octx.shadowColor = ACTION_COLOR;
    octx.shadowBlur = 12;
    octx.fillText('SLAM!', swapped ? w * 0.25 : w * 0.75, h / 2);
    octx.restore();
  }
}

// Small dial in the action hand's bottom corner. "Up" is neutral; the
// green wedge is the ±15° re-arm zone, pink ticks are the ±35° triggers,
// and the needle is the hand's current twist.
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

  if (!twistMode) {
    octx.fillStyle = ACTION_COLOR;
    octx.fillText('PINCH', cx, cy - 2);
    octx.fillText(pinchCW ? '↻' : pinchCCW ? '↺' : '·', cx, cy + 10);
    octx.restore();
    return;
  }

  // Re-arm zone.
  octx.fillStyle = 'rgba(0, 255, 163, 0.25)';
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

  // Trigger marks.
  octx.strokeStyle = ACTION_COLOR;
  octx.lineWidth = 3;
  for (const deg of [-TWIST_TRIGGER_DEG, TWIST_TRIGGER_DEG]) {
    const a = rad(deg);
    octx.beginPath();
    octx.moveTo(cx + Math.cos(a) * (r - 7), cy + Math.sin(a) * (r - 7));
    octx.lineTo(cx + Math.cos(a) * (r + 3), cy + Math.sin(a) * (r + 3));
    octx.stroke();
  }

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
  octx.fillText('TWIST', cx, cy + r - 4);
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

  octx.save();
  octx.strokeStyle = color;
  octx.fillStyle = color;
  octx.shadowColor = color;
  octx.shadowBlur = 8;
  octx.lineWidth = 2;

  for (const [a, b] of CONNECTIONS) {
    const [x1, y1] = px(hand.landmarks[a]);
    const [x2, y2] = px(hand.landmarks[b]);
    octx.beginPath();
    octx.moveTo(x1, y1);
    octx.lineTo(x2, y2);
    octx.stroke();
  }
  for (const lm of hand.landmarks) {
    const [x, y] = px(lm);
    octx.beginPath();
    octx.arc(x, y, 3, 0, Math.PI * 2);
    octx.fill();
  }
  octx.restore();
}

// ---------- Status text ----------
function updateStatus() {
  const moveSide = swapped ? 'R' : 'L';
  const actionSide = swapped ? 'L' : 'R';
  const line = (name, side, hand, cls, extra) =>
    `<div class="${cls}">${name} (${side}): ${hand ? 'TRACKING · curl ' + hand.curl.toFixed(2) + extra : 'not seen'}</div>`;
  const moveExtra = column === null ? '' : ` · COL ${column + 1}${fist ? ' · FIST' : ''}`;
  let actionExtra = twistMode
    ? ` · TWIST ${twistDelta >= 0 ? '+' : ''}${Math.round(twistDelta)}°${twistArmed ? '' : ' (re-arm)'}`
    : ` · PINCH ${pinchIndexGap.toFixed(2)}/${pinchMiddleGap.toFixed(2)}`;
  const now = performance.now();
  const motionNote = isCoolingDown(now) ? ' · COOLDOWN' : handMotion > FAST_MOVE_DISTANCE ? ' · MOVING' : '';
  actionExtra += ` · ↓${slamDrop.toFixed(1)}${motionNote}`;
  statusEl.innerHTML =
    line('MOVE', moveSide, moveHand, 'move', moveExtra) +
    line('ACTION', actionSide, actionHand, 'action', actionExtra) +
    `<div class="mode">ROTATE MODE: ${twistMode ? 'TWIST' : 'PINCH'} (T to switch)</div>`;

  if (debugOn) renderDebug(now);
}

// D key: every live gesture value next to the threshold it's compared with.
// A row lights up when its gesture is currently "on".
function renderDebug(now) {
  const n = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
  const mv = moveHand;
  const ac = actionHand;
  const cooldownLeft = Math.max(0, cooldownUntil - now);
  const sinceOpen = ac ? now - lastOpenTime : null;

  const rows = [
    ['TRACKER', `${delegateUsed} · ${fps} fps`, '', false],
    ['— MOVE HAND', '', '', false],
    ['column pos', mv ? n(columnPos) : '—', `±${COLUMN_HYSTERESIS} past edge`, false],
    ['curl (fist)', mv ? n(mv.curl) : '—', `on <${FIST_ON_CURL} · off >${FIST_OFF_CURL}`, fist],
    ['— ACTION HAND', '', '', false],
    ['twist °', twistMode && ac ? n(twistDelta, 0) : '—', `±${TWIST_TRIGGER_DEG} fire · ±${TWIST_REARM_DEG} re-arm`, twistMode && !twistArmed],
    ['pinch idx', !twistMode && ac ? n(pinchIndexGap) : '—', `on <${PINCH_ON} · off >${PINCH_OFF}`, pinchCW],
    ['pinch mid', !twistMode && ac ? n(pinchMiddleGap) : '—', `on <${PINCH_ON} · off >${PINCH_OFF}`, pinchCCW],
    ['pinky open', !twistMode && ac ? n(dist(ac.pts[20], ac.pts[0]) / ac.palm) : '—', `>${PINKY_OPEN}`, false],
    ['slam drop', ac ? n(slamDrop) : '—', `≥${SLAM_DISTANCE} in ${SLAM_WINDOW_MS}ms`, cooldownLeft > 0],
    ['motion', ac ? n(handMotion) : '—', `>${FAST_MOVE_DISTANCE} blocks`, handMotion > FAST_MOVE_DISTANCE],
    ['cooldown ms', n(cooldownLeft, 0), `${SLAM_COOLDOWN_MS}`, cooldownLeft > 0],
    ['curl (grab)', ac ? n(ac.curl) : '—', `open >${GRAB_OPEN_CURL} → fist <${GRAB_CLOSED_CURL}`, false],
    ['since open ms', ac && grabArmed ? n(sinceOpen, 0) : '—', `≤${GRAB_MAX_MS}`, grabArmed],
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
