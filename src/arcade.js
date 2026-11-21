// arcade.js — the Hand Arcade lobby: two cabinets with attract-mode screens,
// chosen with the mouse, the keyboard, or a hand cursor + held fist.
import './style.css';
import './arcade.css';
import { startTracker, detectHands, drawSkeleton } from './tracker.js';
import { unlockAudio, toggleMute, playEvent } from './sound.js';

const cabinets = [...document.querySelectorAll('.cabinet')];
const room = document.getElementById('room');
const cursorEl = document.getElementById('cursor');
const ringEl = cursorEl.querySelector('.ring');
const camBox = document.getElementById('lobby-cam');
const camStatus = document.getElementById('cam-status');
const video = document.getElementById('cam');
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const soundState = document.getElementById('sound-state');
const handHint = document.getElementById('hand-hint');

let active = 0;
let leaving = false;

// ---------- Best scores ----------
function readNumber(key) {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0; // storage unavailable
  }
}

const best = {
  stack: readNumber('handarcade.best.stack'),
  // Hand Glide keeps one best per control mode; show the highest.
  glide: Math.max(...['handglide-best', 'handglide-best-wings', 'handglide-best-steer'].map(readNumber)),
  whack: readNumber('handarcade.best.whack'),
};
for (const el of document.querySelectorAll('[data-best]')) el.textContent = best[el.dataset.best];

// ---------- Choosing a cabinet ----------
function setActive(i, sound = true) {
  if (leaving || i === active) return;
  active = i;
  cabinets.forEach((c, j) => c.classList.toggle('active', j === i));
  if (sound) playEvent('rotate');
}

function select(i) {
  if (leaving) return;
  leaving = true;
  cabinets.forEach((c, j) => c.classList.toggle('active', j === i));
  playEvent('levelup');

  // Free the camera so the game page can open it straight away.
  if (video.srcObject) for (const track of video.srcObject.getTracks()) track.stop();

  // Zoom the whole room into the chosen cabinet's screen, then fade out.
  const screen = cabinets[i].querySelector('.cab-screen').getBoundingClientRect();
  const box = room.getBoundingClientRect();
  room.style.transformOrigin = `${screen.left + screen.width / 2 - box.left}px ${screen.top + screen.height / 2 - box.top}px`;
  room.style.transform = 'scale(5)';
  document.body.classList.add('zooming');
  cursorEl.hidden = true;
  setTimeout(() => (location.href = cabinets[i].href), 750);
}

cabinets.forEach((cab, i) => {
  cab.addEventListener('pointerenter', () => setActive(i));
  cab.addEventListener('focus', () => setActive(i));
  cab.addEventListener('click', (e) => {
    e.preventDefault();
    unlockAudio();
    select(i);
  });
});
cabinets[0].classList.add('active');

window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (e.repeat) return;
  if (e.code === 'ArrowLeft') setActive(Math.max(0, active - 1));
  if (e.code === 'ArrowRight') setActive(Math.min(cabinets.length - 1, active + 1));
  if (e.code === 'Enter' || e.code === 'Space') {
    e.preventDefault();
    select(active);
  }
  if (e.code === 'KeyM') soundState.textContent = toggleMute() ? 'OFF' : 'ON';
});
window.addEventListener('pointerdown', unlockAudio);

// Coming back with the browser's Back button can restore this page mid-zoom
// with the camera stopped, so start it fresh.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

// ---------- Hand cursor ----------
// Looser than the games' fist so it's easy to trigger (open ≈ 1.9, fist ≈ 0.9).
const FIST_CURL = 1.15;
const OPEN_CURL = 1.35; // the hand must be seen open once before a fist counts
const RELEASE_CURL = 1.3;
const HOLD_MS = 600;
const SMOOTH = 0.35; // cursor EMA weight for the newest position
const HAND_LOST_MS = 400;
const RING = 151; // circumference of the progress ring

let trackerReady = false;
let cx = null;
let cy = null;
let lastSeen = 0;
let armed = false;
let fistSince = null;

// Palm centre in camera space → page position. The middle 60% of the camera
// view covers the whole page, so you don't have to reach the edges.
function toPage(v, size) {
  return Math.min(1, Math.max(0, (v - 0.2) / 0.6)) * size;
}

function updateHandCursor(now) {
  const hands = detectHands();
  if (hands) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    for (const h of hands) drawSkeleton(octx, h, '#00e5ff');

    // Use the biggest (closest) hand.
    const hand = hands.reduce((a, b) => (!a || b.palm > a.palm ? b : a), null);
    if (hand) {
      lastSeen = now;
      const tx = toPage(hand.screenX, innerWidth);
      const ty = toPage(hand.landmarks[9].y, innerHeight);
      cx = cx === null ? tx : cx + SMOOTH * (tx - cx);
      cy = cy === null ? ty : cy + SMOOTH * (ty - cy);

      // Highlight the cabinet whose centre is nearest the cursor horizontally.
      let nearest = 0;
      let bestD = Infinity;
      cabinets.forEach((c, i) => {
        const r = c.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - cx);
        if (d < bestD) [bestD, nearest] = [d, i];
      });
      // Closing the hand shifts the palm a little, so keep the choice locked
      // while the fist is held.
      const closing = hand.curl < RELEASE_CURL;
      if (!closing) setActive(nearest);

      // Hold a fist to choose.
      if (hand.curl > OPEN_CURL) armed = true;
      if (hand.curl > RELEASE_CURL) fistSince = null;
      else if (armed && hand.curl < FIST_CURL && fistSince === null) fistSince = now;

      handHint.textContent = !armed
        ? 'OPEN YOUR HAND TO START POINTING'
        : fistSince !== null
          ? `HOLD IT… ${cabinets[active].querySelector('.cab-top').textContent.trim()}`
          : 'POINT AT A CABINET · MAKE A FIST TO PLAY';
    }
  }

  const visible = now - lastSeen < HAND_LOST_MS && cx !== null;
  if (!visible) fistSince = null;
  cursorEl.hidden = !visible || leaving;
  if (!visible) return;

  cursorEl.style.transform = `translate(${cx}px, ${cy}px)`;
  const progress = fistSince === null ? 0 : Math.min(1, (now - fistSince) / HOLD_MS);
  ringEl.style.strokeDashoffset = String(RING * (1 - progress));
  if (progress >= 1) select(active);
}

const STATUS_TEXT = {
  camera: 'Starting camera…',
  loading: 'Loading hand tracker…',
  ready: 'Show a hand to choose',
  'camera-blocked': 'No camera: mouse / keyboard mode',
  'tracker-failed': 'No tracker: mouse / keyboard mode',
};

startTracker(video, (s) => {
  camStatus.textContent = STATUS_TEXT[s];
  if (s === 'ready') trackerReady = true;
  if (s === 'camera-blocked' || s === 'tracker-failed') {
    camBox.classList.add('off');
    handHint.textContent = 'CLICK A CABINET TO PLAY';
  }
});

// ---------- Attract mode: Hand Stack ----------
const COLORS = ['#ff2bd6', '#00e5ff', '#c6ff00', '#ffb300', '#8f5bff', '#ff3b3b', '#2bff88'];

function makeStackDemo(canvas) {
  const ctx = canvas.getContext('2d');
  const COLS = 10;
  const ROWS = 12;
  const S = canvas.width / COLS;
  const top = canvas.height - ROWS * S;
  let grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  let piece = null;
  let flash = null; // { rows, until }
  let acc = 0;

  // Landing row for a w-wide bar at column x: the highest filled cell in its span.
  function landing(x, w) {
    for (let y = 0; y < ROWS; y++) {
      for (let i = x; i < x + w; i++) if (grid[y][i]) return y - 1;
    }
    return ROWS - 1;
  }

  function spawn() {
    const w = 1 + Math.floor(Math.random() * 4);
    let bestX = 0;
    let bestY = -1;
    for (let x = 0; x <= COLS - w; x++) {
      const y = landing(x, w);
      if (y > bestY || (y === bestY && Math.random() < 0.4)) [bestX, bestY] = [x, y];
    }
    piece = { x: bestX, w, y: -1, target: bestY, color: COLORS[Math.floor(Math.random() * COLORS.length)] };
  }

  function step() {
    if (flash) {
      if (performance.now() < flash.until) return;
      grid = grid.filter((_, y) => !flash.rows.includes(y));
      while (grid.length < ROWS) grid.unshift(Array(COLS).fill(null));
      flash = null;
    }
    if (!piece) spawn();
    if (piece.target < 0) {
      grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null)); // topped out: start over
      piece = null;
      return;
    }
    if (piece.y < piece.target) {
      piece.y++;
      return;
    }
    for (let i = piece.x; i < piece.x + piece.w; i++) grid[piece.y][i] = piece.color;
    piece = null;
    const full = grid.map((row, y) => (row.every(Boolean) ? y : -1)).filter((y) => y >= 0);
    if (full.length) flash = { rows: full, until: performance.now() + 350 };
  }

  function cell(x, y, color) {
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.fillRect(x * S + 1, top + y * S + 1, S - 2, S - 2);
  }

  return (dt) => {
    acc += dt;
    while (acc > 70) {
      acc -= 70;
      step();
    }
    ctx.fillStyle = '#050816';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.shadowBlur = 6;
    const blink = flash && Math.floor(performance.now() / 70) % 2;
    grid.forEach((row, y) =>
      row.forEach((c, x) => c && cell(x, y, flash?.rows.includes(y) ? (blink ? '#ffffff' : c) : c)),
    );
    if (piece && piece.y >= 0) for (let i = piece.x; i < piece.x + piece.w; i++) cell(i, piece.y, piece.color);
    ctx.shadowBlur = 0;
  };
}

// ---------- Attract mode: Hand Glide ----------
function makeGlideDemo(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const SPEED = 70; // px/s
  const CX = 50; // comet x
  const GAP = 70;
  const stars = Array.from({ length: 40 }, () => ({ x: Math.random() * W, y: Math.random() * H, z: 0.3 + Math.random() }));
  let t = 0;
  let gates = [];
  let nextGate = 0;

  const path = (s) => H / 2 + 55 * Math.sin(s * 1.6) + 15 * Math.sin(s * 3.7);

  return (dt) => {
    const s = dt / 1000;
    t += s;
    ctx.fillStyle = '#050816';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#8fa3ff';
    for (const st of stars) {
      st.x -= SPEED * 0.4 * st.z * s;
      if (st.x < 0) st.x += W;
      ctx.globalAlpha = 0.3 + 0.5 * st.z / 1.3;
      ctx.fillRect(st.x, st.y, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;

    // Gates are placed so the comet's path threads their gaps.
    nextGate -= s;
    if (nextGate <= 0) {
      gates.push({ x: W + 10, gapY: path(t + (W + 10 - CX) / SPEED) });
      nextGate = 1.4;
    }
    ctx.shadowBlur = 8;
    for (const g of gates) {
      g.x -= SPEED * s;
      ctx.fillStyle = ctx.shadowColor = '#ff2bd6';
      ctx.fillRect(g.x - 5, 0, 10, g.gapY - GAP / 2);
      ctx.fillRect(g.x - 5, g.gapY + GAP / 2, 10, H);
    }
    gates = gates.filter((g) => g.x > -20);

    // Comet with a fading trail along where it has been.
    for (let i = 14; i >= 0; i--) {
      const back = i * 0.03;
      ctx.globalAlpha = 1 - i / 15;
      ctx.fillStyle = ctx.shadowColor = i ? '#00e5ff' : '#ffffff';
      ctx.beginPath();
      ctx.arc(CX - back * SPEED, path(t - back), 6 - i * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  };
}

const demos = [
  makeStackDemo(cabinets[0].querySelector('.cab-screen')),
  makeGlideDemo(cabinets[1].querySelector('.cab-screen')),
  makeWhackDemo(cabinets[2].querySelector('.cab-screen')),
];

// ---------- Attract mode: Hand Whack ----------
function makeWhackDemo(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const holes = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ x: 32 + c * 58, y: 85 + r * 55 })));
  let moles = []; // { hole, age, life, hit }
  let hammer = { x: W / 2, y: H / 2, target: null, swing: 0 };
  let spawn = 0;

  return (dt) => {
    spawn -= dt;
    if (spawn <= 0 && moles.length < 2) {
      const free = holes.map((_, i) => i).filter((i) => !moles.some((m) => m.hole === i));
      moles.push({ hole: free[Math.floor(Math.random() * free.length)], age: 0, life: 1400, hit: null });
      spawn = 500 + Math.random() * 400;
    }
    for (const m of moles) m.age += dt;
    moles = moles.filter((m) => (m.hit === null ? m.age < m.life : m.age - m.hit < 300));

    // The demo hammer glides to the oldest mole and bops it.
    const target = moles.find((m) => m.hit === null && m.age > 250);
    if (target) {
      const h = holes[target.hole];
      hammer.x += (h.x - hammer.x) * 0.15;
      hammer.y += (h.y - 22 - hammer.y) * 0.15;
      if (Math.hypot(h.x - hammer.x, h.y - 22 - hammer.y) < 4) {
        target.hit = target.age;
        hammer.swing = 1;
      }
    }
    hammer.swing = Math.max(0, hammer.swing - dt / 180);

    ctx.fillStyle = '#050816';
    ctx.fillRect(0, 0, W, H);
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c6ff00';
    ctx.fillText('WHACK!', W / 2, 36);
    holes.forEach((h, i) => {
      ctx.fillStyle = '#02030b';
      ctx.strokeStyle = '#a259ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(h.x, h.y, 22, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const m = moles.find((m) => m.hole === i);
      if (!m) return;
      const up = m.hit !== null ? 1 - (m.age - m.hit) / 300 : Math.min(1, m.age / 120, (m.life - m.age) / 120);
      if (up <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(h.x - 24, h.y - 50, 48, 50);
      ctx.clip();
      ctx.fillStyle = m.hit !== null ? '#c6ff00' : '#a259ff';
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(h.x, h.y + 14 - 28 * up, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillRect(h.x - 6, h.y + 8 - 28 * up, 3, 3);
      ctx.fillRect(h.x + 3, h.y + 8 - 28 * up, 3, 3);
      ctx.restore();
    });
    ctx.save();
    ctx.translate(hammer.x, hammer.y);
    ctx.rotate(-0.6 + hammer.swing);
    ctx.shadowColor = '#ff2bd6';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#c9b8ff';
    ctx.fillRect(-2, -4, 4, 26);
    ctx.fillStyle = '#ff2bd6';
    ctx.fillRect(-11, -13, 22, 11);
    ctx.restore();
  };
}

// ---------- Loop ----------
let last = performance.now();
function loop(now) {
  const dt = Math.min(now - last, 100);
  last = now;
  for (const d of demos) d(dt);
  if (trackerReady && !leaving) updateHandCursor(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
