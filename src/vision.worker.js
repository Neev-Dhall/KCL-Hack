// vision.worker.js — runs MediaPipe hand / pose tracking on a background
// thread, so the game's drawing never has to wait for it.
// Messages in:  { type: 'load', model }  and  { type: 'frame', model, bitmap, ts }
// Messages out: { type: 'loaded', model, delegate }, { type: 'load-failed', model, error },
//               { type: 'result', model, landmarks }, { type: 'frame-failed', model, error }

const MEDIAPIPE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const WASM_URL = MEDIAPIPE_URL + '/wasm';
const MODELS = {
  hand: {
    cls: 'HandLandmarker',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    options: { numHands: 2 },
  },
  pose: {
    cls: 'PoseLandmarker',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    options: { numPoses: 1 },
  },
};

// MediaPipe loads its WebAssembly glue script with importScripts(), which
// throws inside module workers. Replace it with something that does the same
// job: fetch the script synchronously (allowed in workers) and run it in the
// global scope, so it defines the global `ModuleFactory` MediaPipe expects.
// It must really re-run each time: MediaPipe clears that global after each model.
self.importScripts = (...urls) => {
  for (const url of urls) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', String(url), false);
    xhr.send();
    if (xhr.status !== 200) throw new Error(`Could not load ${url} (${xhr.status})`);
    (0, eval)(xhr.responseText); // indirect eval = run as a global script
  }
};

let visionPromise = null;
function getVision() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const vision = await import(/* @vite-ignore */ MEDIAPIPE_URL);
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
      return { vision, fileset };
    })();
  }
  return visionPromise;
}

const landmarkers = {}; // model name → MediaPipe landmarker

async function loadModel(model) {
  const { vision, fileset } = await getVision();
  const spec = MODELS[model];
  const make = (delegate) =>
    vision[spec.cls].createFromOptions(fileset, {
      baseOptions: { modelAssetPath: spec.url, delegate },
      runningMode: 'VIDEO',
      ...spec.options,
    });
  try {
    landmarkers[model] = await make('GPU');
    return 'GPU';
  } catch (gpuErr) {
    console.warn(`${model}: GPU delegate failed, using CPU`, gpuErr);
    landmarkers[model] = await make('CPU');
    return 'CPU';
  }
}

// Models are created one at a time (they share the ModuleFactory global).
let loadQueue = Promise.resolve();

self.onmessage = ({ data: msg }) => {
  if (msg.type === 'load') {
    loadQueue = loadQueue.then(async () => {
      try {
        const delegate = await loadModel(msg.model);
        self.postMessage({ type: 'loaded', model: msg.model, delegate });
      } catch (err) {
        self.postMessage({ type: 'load-failed', model: msg.model, error: String(err) });
      }
    });
  } else if (msg.type === 'frame') {
    const { model, bitmap, ts } = msg;
    try {
      const t0 = performance.now();
      const result = landmarkers[model].detectForVideo(bitmap, ts);
      const detectMs = performance.now() - t0;
      self.postMessage({ type: 'result', model, landmarks: result.landmarks || [], detectMs });
    } catch (err) {
      self.postMessage({ type: 'frame-failed', model, error: String(err) });
    } finally {
      bitmap.close();
    }
  }
};
