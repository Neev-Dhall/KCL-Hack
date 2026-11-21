// tracker.js — shared webcam + tracking for Hand Glide: hands, plus body pose
// for wing flapping (loaded on demand). MediaPipe runs in a background worker
// (vision.js / vision.worker.js), so tracking never freezes the game.

import { Vision } from './vision.js';

// Landmark pairs that make up the hand skeleton.
const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [9, 10], [10, 11], [11, 12], // middle
  [13, 14], [14, 15], [15, 16], // ring
  [0, 17], [17, 18], [18, 19], [19, 20], // pinky
  [5, 9], [9, 13], [13, 17], // across the palm
];
const ARM_LINKS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16]]; // shoulders, arms

let video = null;
let vision = null;
let aspect = 4 / 3;
let markReady;
const ready = new Promise((r) => (markReady = r)); // resolves once the hand tracker is up
let posePromise = null;

// Starts the camera and loads the hand tracker. onStatus gets 'camera' |
// 'loading' | 'ready' | 'camera-blocked' | 'tracker-failed'.
export async function startTracker(videoEl, onStatus) {
  video = videoEl;
  try {
    onStatus('camera');
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: { ideal: 60 }, facingMode: 'user' }, // more fps = less delay
      audio: false,
    });
    await video.play();
    aspect = video.videoWidth / video.videoHeight || 4 / 3;
  } catch (err) {
    console.warn('Camera unavailable:', err);
    onStatus('camera-blocked');
    return false;
  }

  try {
    onStatus('loading');
    vision = new Vision(video);
    await vision.load('hand');
  } catch (err) {
    console.warn('Hand tracker failed to load:', err);
    onStatus('tracker-failed');
    return false;
  }
  onStatus('ready');
  markReady();
  return true;
}

// Loads the pose model (once). Safe to call before the camera is ready.
export function enablePose() {
  if (!posePromise) {
    posePromise = ready
      .then(() => vision.load('pose'))
      .catch((err) => {
        console.warn('Pose tracker failed to load:', err);
        posePromise = null; // allow a retry
      });
  }
  return posePromise;
}

export function isPoseReady() {
  return !!vision && vision.isReady('pose');
}

// Newest hands as measured objects, or null when there's no new result yet.
export function detectHands() {
  if (!vision) return null;
  const hands = vision.poll('hand');
  return hands ? hands.map(measureHand) : null;
}

// Newest pose: null when there's no new result yet, [] when nobody is in view,
// otherwise { landmarks, pts } with pts mirrored + aspect-corrected like hands.
export function detectPose() {
  if (!vision) return null;
  const people = vision.poll('pose');
  if (!people) return null;
  const lm = people[0];
  if (!lm) return [];
  return { landmarks: lm, pts: lm.map((p) => ({ x: (1 - p.x) * aspect, y: p.y, visibility: p.visibility ?? 1 })) };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Distances in "palm lengths" (wrist → landmark 9) so they work at any range.
function measureHand(landmarks) {
  const pts = landmarks.map((lm) => ({ x: (1 - lm.x) * aspect, y: lm.y })); // mirrored
  const palm = dist(pts[0], pts[9]) || 1e-6;
  const tips = [8, 12, 16, 20];
  const curl = tips.reduce((sum, i) => sum + dist(pts[i], pts[0]), 0) / tips.length / palm;
  return { landmarks, pts, palm, curl, screenX: 1 - landmarks[9].x };
}

// Draws one hand's skeleton, mirrored to match the video. All bones go in
// one path and all joints in another, so the glow is applied twice per hand
// instead of 42 times.
export function drawSkeleton(ctx, hand, color) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const X = (lm) => (1 - lm.x) * w;
  const Y = (lm) => lm.y * h;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    ctx.moveTo(X(hand.landmarks[a]), Y(hand.landmarks[a]));
    ctx.lineTo(X(hand.landmarks[b]), Y(hand.landmarks[b]));
  }
  ctx.stroke();
  ctx.beginPath();
  for (const lm of hand.landmarks) {
    ctx.moveTo(X(lm) + 3, Y(lm));
    ctx.arc(X(lm), Y(lm), 3, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
}

// Draws shoulders, arms and wrists (mirrored like the video), batched the same way.
export function drawArms(ctx, pose, color) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const X = (i) => (1 - pose.landmarks[i].x) * w;
  const Y = (i) => pose.landmarks[i].y * h;
  const seen = (i) => (pose.landmarks[i].visibility ?? 1) > 0.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (const [a, b] of ARM_LINKS) {
    if (!seen(a) || !seen(b)) continue;
    ctx.moveTo(X(a), Y(a));
    ctx.lineTo(X(b), Y(b));
  }
  ctx.stroke();
  ctx.beginPath();
  for (const i of [11, 12, 13, 14, 15, 16]) {
    if (!seen(i)) continue;
    const r = i >= 15 ? 7 : 4;
    ctx.moveTo(X(i) + r, Y(i));
    ctx.arc(X(i), Y(i), r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
}
