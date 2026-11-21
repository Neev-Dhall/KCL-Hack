// main.js — wires the game, hand tracking, sound and keyboard together,
// and runs the game loop.
import './style.css';
import * as game from './game.js';
import { initHands, updateHands, swapHands, toggleDebug, onHands } from './hands.js';
import { createHandMenu } from './handmenu.js';
import { unlockAudio, toggleMute, playEvent, startMusic, stopMusic } from './sound.js';

const guide = document.getElementById('guide');
const controls = document.getElementById('controls');
let musicPlaying = false;
const soundState = document.getElementById('sound-state');

game.init(document.getElementById('game'));
game.onEvent(playEvent); // game events → sound effects
initHands(); // async; the keyboard works while the camera loads (or if it's denied)

// Browsers only allow sound after the user clicks or presses a key.
window.addEventListener('pointerdown', unlockAudio);

// ---------- Keyboard ----------
// Keys whose default browser action (scrolling) we block.
const BLOCKED = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'];

window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (BLOCKED.includes(e.code)) e.preventDefault();
  const { status } = game.getState();

  // Keys that work on any screen.
  if (!e.repeat) {
    switch (e.code) {
      case 'Enter':
        if (status === 'start' || status === 'over') game.start();
        return;
      case 'Escape':
        if (status !== 'playing') location.href = './';
        return;
      case 'KeyP':
        game.togglePause();
        return;
      case 'KeyS':
        swapHands();
        return;
      case 'KeyD':
        toggleDebug();
        return;
      case 'KeyM':
        soundState.textContent = toggleMute() ? 'OFF' : 'ON';
        return;
    }
  }
  if (status !== 'playing') return;

  // Left/right may auto-repeat when held; every other key acts once per press.
  if (e.code === 'ArrowLeft') game.move(-1);
  if (e.code === 'ArrowRight') game.move(1);
  if (e.repeat) return;

  switch (e.code) {
    case 'ArrowDown':
      game.setSoftDrop(true);
      break;
    case 'ArrowUp':
    case 'KeyX':
      game.rotate(1);
      break;
    case 'KeyZ':
      game.rotate(-1);
      break;
    case 'Space':
      game.hardDrop();
      break;
    case 'KeyC':
      game.hold();
      break;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowDown') game.setSoftDrop(false);
});

// ---------- Hand menu: hover a hand over ARCADE / PLAY on menu screens ----------
const menu = createHandMenu([
  { id: 'arcade', side: 'left', label: '◀ ARCADE', action: () => (location.href = './') },
  {
    id: 'play',
    side: 'right',
    label: 'PLAY ▶',
    action: () => {
      unlockAudio();
      const { status } = game.getState();
      if (status === 'paused') game.togglePause();
      else if (status === 'start' || status === 'over') game.start();
    },
  },
]);
// Palm centres, mirrored to match the screen.
onHands((hands) => menu.feed(hands.map((lm) => ({ x: 1 - lm[9].x, y: lm[9].y }))));

// ---------- Best score (shown on the arcade cabinet) ----------
const BEST_KEY = 'handarcade.best.stack';
let lastStatus = 'start';

function saveBest(score) {
  try {
    if (score > (Number(localStorage.getItem(BEST_KEY)) || 0)) localStorage.setItem(BEST_KEY, String(score));
  } catch {
    /* storage unavailable: the best score just isn't kept */
  }
}

// ---------- Game loop ----------
let last = performance.now();

function loop(now) {
  const dt = Math.min(now - last, 100); // clamp so a background tab doesn't jump ahead
  last = now;
  updateHands(); // runs hand detection once per new camera frame
  game.update(dt);
  game.draw();

  const { status, score } = game.getState();
  if (status === 'over' && lastStatus !== 'over') saveBest(score);
  lastStatus = status;
  menu.setLabel('play', status === 'paused' ? 'RESUME ▶' : status === 'over' ? 'AGAIN ▶' : 'PLAY ▶');
  menu.frame(now, status !== 'playing');

  // The big gesture guide shows before the first game; the compact
  // controls list shows from then on.
  const showGuide = status === 'start';
  if (guide.hidden === showGuide) guide.hidden = !showGuide;
  if (controls.hidden !== showGuide) controls.hidden = showGuide;

  // Music only plays during a game (stops when paused or over).
  const wantMusic = status === 'playing';
  if (wantMusic !== musicPlaying) {
    if (wantMusic) startMusic();
    else stopMusic();
    musicPlaying = wantMusic;
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
