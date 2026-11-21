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

// ---------- Setup ----------
export async function initHands() {
  video = document.getElementById('cam');
  overlay = document.getElementById('overlay');
  octx = overlay.getContext('2d');
  statusEl = document.getElementById('hand-status');

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
    } catch (gpuErr) {
      console.warn('GPU delegate failed, using CPU:', gpuErr);
      landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
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

// ---------- Per-frame update (called from the game loop) ----------
export function updateHands() {
  if (!landmarker || video.readyState < 2) return;

  // Only run detection once per new video frame.
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const result = landmarker.detectForVideo(video, performance.now());
  assignRoles(result.landmarks || []);

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

  if (moveHand) drawSkeleton(moveHand, MOVE_COLOR);
  if (actionHand) drawSkeleton(actionHand, ACTION_COLOR);
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
  const line = (name, side, hand, cls) =>
    `<div class="${cls}">${name} (${side}): ${hand ? 'TRACKING · curl ' + hand.curl.toFixed(2) : 'not seen'}</div>`;
  statusEl.innerHTML =
    line('MOVE', moveSide, moveHand, 'move') + line('ACTION', actionSide, actionHand, 'action');
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function showCameraMessage(html) {
  const msg = document.getElementById('cam-message');
  msg.innerHTML = html;
  msg.hidden = false;
}
