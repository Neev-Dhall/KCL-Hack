// main.js — wires the game to the keyboard and runs the game loop.
import './style.css';
import * as game from './game.js';
import { initHands, updateHands, swapHands, toggleTwistMode } from './hands.js';

game.init(document.getElementById('game'));
initHands(); // async; the keyboard works while the camera loads (or if it's denied)

// ---------- Keyboard ----------
// Keys whose default browser action (scrolling) we block.
const BLOCKED = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'];

window.addEventListener('keydown', (e) => {
  if (BLOCKED.includes(e.code)) e.preventDefault();
  const { status } = game.getState();

  if (e.code === 'Enter' && (status === 'start' || status === 'over')) {
    game.start();
    return;
  }
  if (e.code === 'KeyP' && !e.repeat) {
    game.togglePause();
    return;
  }
  if (e.code === 'KeyS' && !e.repeat) {
    swapHands();
    return;
  }
  if (e.code === 'KeyT' && !e.repeat) {
    toggleTwistMode();
    return;
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

// ---------- Game loop ----------
let last = performance.now();

function loop(now) {
  const dt = Math.min(now - last, 100); // clamp so a background tab doesn't jump ahead
  last = now;
  updateHands(); // runs hand detection once per new camera frame
  game.update(dt);
  game.draw();
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
