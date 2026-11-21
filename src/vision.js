// vision.js — the game-side half of tracking. It hands camera frames to
// vision.worker.js and collects the results, so detection runs in parallel
// with the game instead of freezing it.
//
// Each new camera frame is copied into an ImageBitmap and sent to the worker.
// If the worker is still busy with the previous frame, the new one is simply
// skipped, so results never queue up and lag behind.

export class Vision {
  constructor(video) {
    this.video = video;
    this.worker = new Worker(new URL('./vision.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => console.warn('Vision worker error:', e.message);
    this.busy = false; // a frame is being processed
    this.lastVideoTime = -1;
    this.loading = {}; // model → Promise of its delegate ('GPU' / 'CPU')
    this.waiters = {}; // model → { resolve, reject }
    this.ready = {}; // model → true once loaded
    this.results = {}; // model → newest unread landmarks
  }

  // Loads a model ('hand' or 'pose') in the worker. Resolves with 'GPU' or 'CPU'.
  load(model) {
    if (!this.loading[model]) {
      this.loading[model] = new Promise((resolve, reject) => {
        this.waiters[model] = { resolve, reject };
        this.worker.postMessage({ type: 'load', model });
      });
    }
    return this.loading[model];
  }

  isReady(model) {
    return !!this.ready[model];
  }

  // Call every game frame. Returns the newest landmarks for `model` once
  // (an array: hands for 'hand', people for 'pose'), or null if nothing new.
  poll(model) {
    this.sendFrame(model);
    const result = this.results[model];
    if (result === undefined) return null;
    delete this.results[model];
    return result;
  }

  sendFrame(model) {
    const v = this.video;
    if (this.busy || !this.ready[model] || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.busy = true;
    this.lastVideoTime = v.currentTime;
    createImageBitmap(v)
      .then((bitmap) => this.worker.postMessage({ type: 'frame', model, bitmap, ts: performance.now() }, [bitmap]))
      .catch((err) => {
        this.busy = false;
        console.warn('Could not grab camera frame:', err);
      });
  }

  onMessage(msg) {
    if (msg.type === 'loaded') {
      this.ready[msg.model] = true;
      this.waiters[msg.model].resolve(msg.delegate);
    } else if (msg.type === 'load-failed') {
      delete this.loading[msg.model]; // allow a retry
      this.waiters[msg.model].reject(new Error(msg.error));
    } else if (msg.type === 'result') {
      this.busy = false;
      this.results[msg.model] = msg.landmarks;
    } else if (msg.type === 'frame-failed') {
      this.busy = false;
      console.warn('Tracking frame failed:', msg.error);
    }
  }
}
