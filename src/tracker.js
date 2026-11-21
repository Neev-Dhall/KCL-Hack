// tracker.js — shared webcam + MediaPipe hand tracking (used by Hand Glide).
// Returns measured hands; the game decides what the gestures mean.

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

const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

let video = null;
let landmarker = null;
let lastVideoTime = -1;
let aspect = 4 / 3;

// Pose tracking (shoulders, elbows, wrists) is loaded only when asked for.
let vision = null; // the MediaPipe module
let fileset = null;
let poseLandmarker = null;
let posePromise = null;
let lastPoseTime = -1;
let markReady;
const ready = new Promise((r) => (markReady = r)); // resolves once the hand tracker is up

// Starts the camera and loads the tracker. onStatus gets 'camera' | 'loading' |
// 'ready' | 'camera-blocked' | 'tracker-failed'. Resolves true when tracking works.
export async function startTracker(videoEl, onStatus) {
  video = videoEl;
  try {
    onStatus('camera');
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
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
    vision = await import(/* @vite-ignore */ MEDIAPIPE_URL);
    const { FilesetResolver, HandLandmarker } = vision;
    fileset = await FilesetResolver.forVisionTasks(WASM_URL);
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
      .then(async () => {
        const options = (delegate) => ({
          baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
        try {
          poseLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, options('GPU'));
        } catch (gpuErr) {
          console.warn('Pose GPU delegate failed, using CPU:', gpuErr);
          poseLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, options('CPU'));
        }
      })
      .catch((err) => {
        console.warn('Pose tracker failed to load:', err);
        posePromise = null; // allow a retry
      });
  }
  return posePromise;
}

export function isPoseReady() {
  return poseLandmarker !== null;
}

// Runs pose detection once per NEW camera frame. Returns null when there's no
// new frame (or no model yet), [] when nobody is in view, otherwise
// { landmarks, pts } where pts are mirrored + aspect-corrected like hands.
export function detectPose() {
  if (!poseLandmarker || video.readyState < 2 || video.currentTime === lastPoseTime) return null;
  lastPoseTime = video.currentTime;
  const result = poseLandmarker.detectForVideo(video, performance.now());
  const lm = result.landmarks && result.landmarks[0];
  if (!lm) return [];
  return { landmarks: lm, pts: lm.map((p) => ({ x: (1 - p.x) * aspect, y: p.y, visibility: p.visibility ?? 1 })) };
}

// Draws shoulders, arms and wrists on an overlay canvas (mirrored like the video).
export function drawArms(ctx, pose, color) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const px = (i) => [(1 - pose.landmarks[i].x) * w, pose.landmarks[i].y * h];
  const seen = (i) => (pose.landmarks[i].visibility ?? 1) > 0.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.lineWidth = 4;
  for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16]]) {
    if (!seen(a) || !seen(b)) continue;
    const [x1, y1] = px(a);
    const [x2, y2] = px(b);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  for (const i of [11, 12, 13, 14, 15, 16]) {
    if (!seen(i)) continue;
    const [x, y] = px(i);
    ctx.beginPath();
    ctx.arc(x, y, i >= 15 ? 7 : 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Runs detection once per NEW camera frame. Returns an array of measured
// hands, or null when there's no new frame yet.
export function detectHands() {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return null;
  lastVideoTime = video.currentTime;
  const result = landmarker.detectForVideo(video, performance.now());
  return (result.landmarks || []).map(measureHand);
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

// Draws one hand's skeleton on an overlay canvas, mirrored to match the video.
export function drawSkeleton(ctx, hand, color) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const px = (lm) => [(1 - lm.x) * w, lm.y * h];
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.lineWidth = 2;
  for (const [a, b] of CONNECTIONS) {
    const [x1, y1] = px(hand.landmarks[a]);
    const [x2, y2] = px(hand.landmarks[b]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  for (const lm of hand.landmarks) {
    const [x, y] = px(lm);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
