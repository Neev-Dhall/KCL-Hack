# Hand Stack

**A falling-block puzzle you play with your hands.** Built for the **Retro Remix** track: an arcade idea from the 1980s, rebuilt for 2026 with real-time hand tracking in the browser.

Your webcam watches both hands. Your left hand steers the falling piece across the board, and your right hand rotates, slams and holds it. You don't need a controller, and nothing gets installed: MediaPipe runs the hand tracking entirely in the browser.

Built with **JetBrains Air** for **KCL Tech First Year Hack**.

---

## Controls

Left hand = **MOVE** hand (cyan). Right hand = **ACTION** hand (pink). Press **S** to swap them for left-handers.

| Hand | Gesture | Action |
|---|---|---|
| Left | Palm over one of the 10 column bands on the camera view | Piece slides to that column |
| Left | Hold a closed fist | Soft drop |
| Right | Pinch thumb + index, then turn your hand like a dial right / left (release the pinch to reset) | Rotate clockwise / anticlockwise |
| Right | Fast downward swipe | Hard drop ("slam") |
| Right | Quick grab: open hand → fist | Hold the piece (also starts the game) |
| Right (backup, **T** toggles) | Thumb + index pinch / thumb + middle pinch | Rotate clockwise / anticlockwise |

### Keyboard backup

| Key | Action |
|---|---|
| ← → | Move |
| ↓ | Soft drop |
| ↑ or X / Z | Rotate clockwise / anticlockwise |
| Space | Hard drop |
| C | Hold |
| P | Pause |
| Enter | Start / restart |
| S | Swap hand roles (left-handed mode) |
| T | Switch rotation between wrist twist and pinch |
| D | Debug panel (live gesture values vs thresholds) |
| M | Mute / unmute |

## Running it

You need [Node.js](https://nodejs.org/) 20 or newer, a webcam and an internet connection (the hand-tracking model loads from a CDN).

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173) in **Google Chrome** and allow camera access. If the camera is blocked, the game still works with the keyboard.

Sound starts after your first click or key press, because browsers block audio until then.

## How it works

| File | Job |
|---|---|
| `src/game.js` | Game rules and drawing only: the board, the 7-bag randomiser, wall kicks, scoring, levels and the neon canvas renderer. It knows nothing about cameras. |
| `src/hands.js` | Camera, MediaPipe hand tracking and gesture detection. It only talks to the game through the API that `game.js` exports. **Every gesture threshold is in one commented block at the top.** |
| `src/sound.js` | Small sound effects synthesised with the Web Audio API (no audio files). |
| `src/main.js` | Wires everything together: keyboard, sound and the game loop. |

### Gesture tricks

- **Scale-free:** every distance is measured in *palm lengths* (wrist to the middle-finger knuckle), so gestures work whether you're near the camera or far from it.
- **Hysteresis everywhere:** columns, fists and pinches all use separate "on" and "off" thresholds, so they don't flicker at the edge.
- **Pinch-clutch twist:** twisting only counts while thumb and index are pinched, like gripping a real dial. A 15° turn rotates once, and you can keep turning for more rotations. Release the pinch to bring your hand back without rotating anything.
- **Slam guard:** after a slam, the right hand's gestures are ignored for 600 ms, and twists and grabs don't count while the hand is moving fast. That way a swipe can't accidentally rotate or hold the piece.

Press **D** in game to see every live gesture value next to its threshold.

## Tech

Plain JavaScript, HTML canvas and CSS, served with Vite. No frameworks. Hand tracking uses [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) (`HandLandmarker`, GPU delegate with CPU fallback). The font is Press Start 2P from Google Fonts.
