// game.js — Hand Stack game logic and drawing.
// No camera code lives here: hands.js and main.js only talk to the exported API.

// ---------- Constants ----------
export const COLS = 10;
export const ROWS = 20;
export const CELL = 30;

const BOARD_W = COLS * CELL; // 300
const BOARD_H = ROWS * CELL; // 600
const PANEL_X = BOARD_W + 20; // side panel starts here
const PANEL_W = 160;
export const CANVAS_W = PANEL_X + PANEL_W; // 480
export const CANVAS_H = BOARD_H; // 600

const SLIDE_MS = 15; // moveTo(): one column every 15 ms (quick, so hand moves feel instant)
const SOFT_DROP_MS = 40; // gravity interval while soft dropping
const FLASH_MS = 700; // how long on-board text flashes last
const KICKS = [0, -1, 1, -2, 2]; // wall-kick x offsets tried when rotating
const LINE_SCORES = [0, 100, 300, 500, 800];
const LINE_NAMES = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD!'];

// The 7 four-cell shapes, as square matrices (1 = filled).
const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
};

// Hand Stack's own neon palette.
const COLORS = {
  I: '#ff2bd6', // hot pink
  O: '#c6ff00', // lime
  T: '#00e5ff', // electric cyan
  S: '#ff8a00', // neon orange
  Z: '#a259ff', // violet
  J: '#ffe600', // laser yellow
  L: '#00ffa3', // mint
};

const BG = '#0a0f2c'; // dark navy
const BOARD_BG = '#060a1f';
const FONT = '"Press Start 2P", monospace';

// ---------- State ----------
let canvas = null;
let ctx = null;

let board = []; // board[row][col] = shape letter or null
let piece = null; // { type, matrix, x, y }
let queue = []; // upcoming shape letters (7-bag)
let holdType = null;
let canHold = true;

let score = 0;
let lines = 0;
let level = 1;
let status = 'start'; // 'start' | 'playing' | 'paused' | 'over'

let gravityTimer = 0;
let slideTimer = 0;
let targetColumn = null; // set by moveTo(), null = no target
let softDrop = false;

let flashText = '';
let flashTime = 0;

let statusSince = 0; // performance.now() when the game last started or ended

// ---------- Events (used by main.js for sounds) ----------
// Events: 'start', 'rotate', 'hold', 'slam', 'clear' (lines), 'levelup' (level), 'gameover'
let listener = () => {};

export function onEvent(fn) {
  listener = fn;
}

function emit(name, value) {
  listener(name, value);
}

// ---------- Setup ----------
export function init(canvasEl) {
  canvas = canvasEl;
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx = canvas.getContext('2d');
  board = emptyBoard();
}

export function start() {
  board = emptyBoard();
  queue = [];
  holdType = null;
  canHold = true;
  score = 0;
  lines = 0;
  level = 1;
  gravityTimer = 0;
  slideTimer = 0;
  softDrop = false;
  flashTime = 0;
  status = 'playing';
  statusSince = performance.now();
  emit('start');
  spawn(nextType());
}

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

// ---------- 7-bag randomiser ----------
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Keep at least 7 upcoming pieces so the NEXT preview always has something.
function nextType() {
  while (queue.length < 7) queue.push(...shuffle(Object.keys(SHAPES)));
  return queue.shift();
}

// ---------- Piece helpers ----------
function spawn(type) {
  const matrix = SHAPES[type].map((row) => [...row]);
  piece = { type, matrix, x: Math.floor((COLS - matrix.length) / 2), y: 0 };
  gravityTimer = 0;
  if (collides(piece.matrix, piece.x, piece.y)) {
    status = 'over';
    statusSince = performance.now();
    flash('GAME OVER');
    emit('gameover');
  }
}

// True if the matrix at (x, y) hits a wall, the floor or a locked block.
function collides(matrix, x, y) {
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (!matrix[r][c]) continue;
      const bx = x + c;
      const by = y + r;
      if (bx < 0 || bx >= COLS || by >= ROWS) return true;
      if (by >= 0 && board[by][bx]) return true;
    }
  }
  return false;
}

function tryMove(dx, dy) {
  if (collides(piece.matrix, piece.x + dx, piece.y + dy)) return false;
  piece.x += dx;
  piece.y += dy;
  return true;
}

// dir = 1 clockwise, -1 anticlockwise
function rotateMatrix(matrix, dir) {
  const n = matrix.length;
  return matrix.map((row, r) =>
    row.map((_, c) => (dir > 0 ? matrix[n - 1 - c][r] : matrix[c][n - 1 - r]))
  );
}

// Leftmost and rightmost filled column inside the piece's matrix.
function filledRange(matrix) {
  let min = Infinity;
  let max = -Infinity;
  matrix.forEach((row) =>
    row.forEach((v, c) => {
      if (v) {
        min = Math.min(min, c);
        max = Math.max(max, c);
      }
    })
  );
  return { min, max };
}

// The board column under the middle of the piece's filled cells.
function centreColumn() {
  const { min, max } = filledRange(piece.matrix);
  return piece.x + Math.floor((min + max) / 2);
}

// The board columns the piece will cover once it reaches targetColumn
// (pushed back inside the walls if the piece is too wide to centre there).
function targetColumns() {
  const { min, max } = filledRange(piece.matrix);
  let x = targetColumn - Math.floor((min + max) / 2);
  x = Math.max(-min, Math.min(COLS - 1 - max, x));
  const cols = [];
  for (let c = min; c <= max; c++) cols.push(x + c);
  return cols;
}

function ghostY() {
  let y = piece.y;
  while (!collides(piece.matrix, piece.x, y + 1)) y++;
  return y;
}

function gravityMs() {
  return Math.max(80, 800 - (level - 1) * 70);
}

function flash(text) {
  flashText = text;
  flashTime = FLASH_MS;
}

function lockPiece() {
  piece.matrix.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v && piece.y + r >= 0) board[piece.y + r][piece.x + c] = piece.type;
    })
  );
  clearLines();
  canHold = true;
  spawn(nextType());
}

function clearLines() {
  const kept = board.filter((row) => row.some((cell) => !cell));
  const cleared = ROWS - kept.length;
  if (cleared === 0) return;

  while (kept.length < ROWS) kept.unshift(Array(COLS).fill(null));
  board = kept;

  score += LINE_SCORES[cleared] * level;
  lines += cleared;
  const newLevel = 1 + Math.floor(lines / 10);
  if (newLevel > level) {
    level = newLevel;
    flash('LEVEL ' + level);
    emit('levelup', level);
  } else {
    flash(LINE_NAMES[cleared]);
    emit('clear', cleared);
  }
}

// ---------- Public controls ----------
export function moveTo(column) {
  targetColumn = column === null ? null : Math.max(0, Math.min(COLS - 1, column));
}

export function move(dx) {
  if (status !== 'playing') return;
  targetColumn = null; // keyboard input cancels any hand target
  tryMove(dx, 0);
}

export function rotate(dir) {
  if (status !== 'playing') return;
  const rotated = rotateMatrix(piece.matrix, dir);
  for (const kick of KICKS) {
    if (!collides(rotated, piece.x + kick, piece.y)) {
      piece.matrix = rotated;
      piece.x += kick;
      emit('rotate');
      return;
    }
  }
}

export function hardDrop() {
  if (status !== 'playing') return;
  const target = ghostY();
  score += (target - piece.y) * 2;
  piece.y = target;
  flash('SLAM');
  emit('slam');
  lockPiece();
}

export function hold() {
  if (status !== 'playing' || !canHold) return;
  const current = piece.type;
  if (holdType === null) {
    spawn(nextType());
  } else {
    spawn(holdType);
  }
  holdType = current;
  canHold = false;
  flash('HOLD');
  emit('hold');
}

export function setSoftDrop(on) {
  softDrop = !!on;
}

export function togglePause() {
  if (status === 'playing') status = 'paused';
  else if (status === 'paused') status = 'playing';
}

export function getState() {
  return {
    status,
    statusTime: performance.now() - statusSince, // ms since the game started or ended
    score,
    lines,
    level,
    canHold,
    holdType,
    softDrop,
    targetColumn,
    pieceColumn: piece ? centreColumn() : null,
  };
}

// ---------- Update (called every frame with dt in ms) ----------
export function update(dt) {
  if (flashTime > 0) flashTime -= dt;
  if (status !== 'playing') return;

  // Slide one column every SLIDE_MS toward the target column.
  if (targetColumn !== null) {
    slideTimer += dt;
    if (slideTimer >= SLIDE_MS) {
      slideTimer = 0;
      const diff = targetColumn - centreColumn();
      if (diff !== 0) tryMove(Math.sign(diff), 0); // stops at walls and blocks
    }
  }

  // Gravity.
  const interval = softDrop ? Math.min(SOFT_DROP_MS, gravityMs()) : gravityMs();
  gravityTimer += dt;
  if (gravityTimer >= interval) {
    gravityTimer = 0;
    if (tryMove(0, 1)) {
      if (softDrop) score += 1;
    } else {
      lockPiece();
    }
  }
}

// ---------- Drawing ----------
export function draw() {
  if (!ctx) return;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawBoard();
  drawPanel();
}

function drawBoard() {
  // Background and faint grid.
  ctx.fillStyle = BOARD_BG;
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  ctx.strokeStyle = 'rgba(80, 120, 255, 0.08)';
  ctx.lineWidth = 1;
  for (let c = 1; c < COLS; c++) line(c * CELL + 0.5, 0, c * CELL + 0.5, BOARD_H);
  for (let r = 1; r < ROWS; r++) line(0, r * CELL + 0.5, BOARD_W, r * CELL + 0.5);

  drawTarget();

  // Locked blocks.
  board.forEach((row, r) =>
    row.forEach((type, c) => {
      if (type) drawCell(c * CELL, r * CELL, CELL, COLORS[type]);
    })
  );

  if (piece && status !== 'start') {
    // Ghost outline where the piece will land.
    const gy = ghostY();
    eachCell(piece.matrix, (r, c) => {
      ctx.strokeStyle = COLORS[piece.type] + '88';
      ctx.lineWidth = 2;
      ctx.strokeRect((piece.x + c) * CELL + 3, (gy + r) * CELL + 3, CELL - 6, CELL - 6);
    });
    // Falling piece.
    eachCell(piece.matrix, (r, c) => {
      if (piece.y + r >= 0) drawCell((piece.x + c) * CELL, (piece.y + r) * CELL, CELL, COLORS[piece.type]);
    });
  }

  // Faint CRT scanlines.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  for (let y = 0; y < BOARD_H; y += 3) ctx.fillRect(0, y, BOARD_W, 1);

  // Neon border.
  ctx.save();
  ctx.strokeStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 12;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, BOARD_W - 2, BOARD_H - 2);
  ctx.restore();

  drawFlash();
  drawOverlay();
}

// Light tint on the columns the piece is heading to, plus a marker
// at the top of the chosen column (set by moveTo / the move hand).
function drawTarget() {
  if (targetColumn === null || !piece || status !== 'playing') return;
  ctx.fillStyle = 'rgba(0, 229, 255, 0.07)';
  for (const c of targetColumns()) ctx.fillRect(c * CELL, 0, CELL, BOARD_H);

  const cx = targetColumn * CELL + CELL / 2;
  ctx.save();
  ctx.fillStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(cx - 7, 3);
  ctx.lineTo(cx + 7, 3);
  ctx.lineTo(cx, 12);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawFlash() {
  if (flashTime <= 0 || status === 'start') return;
  const t = flashTime / FLASH_MS; // 1 → 0
  ctx.save();
  ctx.globalAlpha = Math.min(1, t * 1.5);
  ctx.font = `20px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#ff2bd6';
  ctx.shadowBlur = 16;
  ctx.fillText(flashText, BOARD_W / 2, BOARD_H * 0.4 - (1 - t) * 30);
  ctx.restore();
}

function drawOverlay() {
  if (status === 'playing') return;
  ctx.fillStyle = 'rgba(6, 10, 31, 0.78)';
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  ctx.textAlign = 'center';

  if (status === 'start') {
    glowText('HAND', BOARD_W / 2, 220, 32, '#ff2bd6');
    glowText('STACK', BOARD_W / 2, 270, 32, '#00e5ff');
    blinkText('PRESS ENTER', BOARD_W / 2, 360, 12);
  } else if (status === 'paused') {
    glowText('PAUSED', BOARD_W / 2, 280, 24, '#ffe600');
    blinkText('P TO RESUME', BOARD_W / 2, 330, 10);
  } else if (status === 'over') {
    glowText('GAME', BOARD_W / 2, 220, 28, '#ff2bd6');
    glowText('OVER', BOARD_W / 2, 265, 28, '#ff2bd6');
    glowText('SCORE ' + score, BOARD_W / 2, 320, 12, '#c6ff00');
    blinkText('FIST OR ENTER', BOARD_W / 2, 370, 10);
    blinkText('TO RETRY', BOARD_W / 2, 390, 10);
  }
}

function drawPanel() {
  const x = PANEL_X;

  label('HOLD', x, 18);
  box(x, 28, PANEL_W, 80);
  if (holdType) drawPreview(holdType, x + PANEL_W / 2, 68, 20, !canHold);

  label('NEXT', x, 136);
  box(x, 146, PANEL_W, 210);
  if (status !== 'start') {
    queue.slice(0, 3).forEach((type, i) => drawPreview(type, x + PANEL_W / 2, 185 + i * 66, i === 0 ? 20 : 16, false));
  }

  stat('SCORE', score, x, 390, '#c6ff00');
  stat('LINES', lines, x, 460, '#00e5ff');
  stat('LEVEL', level, x, 530, '#ff2bd6');
}

// ---------- Small drawing helpers ----------
function line(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function eachCell(matrix, fn) {
  matrix.forEach((row, r) => row.forEach((v, c) => v && fn(r, c)));
}

function drawCell(x, y, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
  ctx.restore();
  // Inner shine so blocks look lit from above.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.fillRect(x + 3, y + 3, size - 6, 3);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fillRect(x + 3, y + size - 6, size - 6, 3);
}

// Draws a shape centred on (cx, cy). grey = true when hold is locked.
function drawPreview(type, cx, cy, size, grey) {
  const cells = [];
  eachCell(SHAPES[type], (r, c) => cells.push([r, c]));
  const minR = Math.min(...cells.map((p) => p[0]));
  const maxR = Math.max(...cells.map((p) => p[0]));
  const minC = Math.min(...cells.map((p) => p[1]));
  const maxC = Math.max(...cells.map((p) => p[1]));
  const w = (maxC - minC + 1) * size;
  const h = (maxR - minR + 1) * size;
  const color = grey ? '#3a4060' : COLORS[type];
  cells.forEach(([r, c]) => drawCell(cx - w / 2 + (c - minC) * size, cy - h / 2 + (r - minR) * size, size, color));
}

function label(text, x, y) {
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#8fa3ff';
  ctx.fillText(text, x, y);
}

function box(x, y, w, h) {
  ctx.fillStyle = BOARD_BG;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

function stat(name, value, x, y, color) {
  label(name, x, y);
  ctx.save();
  ctx.font = `16px ${FONT}`;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.fillText(String(value), x, y + 28);
  ctx.restore();
}

function glowText(text, x, y, size, color) {
  ctx.save();
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function blinkText(text, x, y, size) {
  if (Math.floor(performance.now() / 500) % 2) return;
  glowText(text, x, y, size, '#ffffff');
}
