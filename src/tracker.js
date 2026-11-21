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

let video = null;
let landmarker = null;
let lastVideoTime = -1;
let aspect = 4 / 3;

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
    onStatus('tracker-failed');
    return false;
  }
  onStatus('ready');
  return true;
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
