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
| Left | Tap thumb and index together | Rotate 90° clockwise |
| Right | Palm facing camera, turn it left like a dial, then back to centre | Rotate 90° anticlockwise |
| Right | Tap thumb and index together | Hold the piece |
| Right | Close into a fist | Hard drop ("slam"); also starts the game |

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
| D | Debug panel (live gesture values vs thresholds) |
| M | Mute / unmute (sound effects and music) |

## Running it

You need [Node.js](https://nodejs.org/) 20 or newer, a webcam and an internet connection (the hand-tracking model loads from a CDN).

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173) in **Google Chrome** and allow camera access. If the camera is blocked, the game still works with the keyboard.

Sound and music start after your first click or key press, because browsers block audio until then.

## How it works

| File | Job |
|---|---|
| `src/game.js` | Game rules and drawing only: the board, the 7-bag randomiser, wall kicks, scoring, levels and the neon canvas renderer. It knows nothing about cameras. |
| `src/hands.js` | Camera, MediaPipe hand tracking and gesture detection. It only talks to the game through the API that `game.js` exports. **Every gesture threshold is in one commented block at the top.** |
| `src/sound.js` | Sound effects and an original chiptune music loop, all synthesised with the Web Audio API (no audio files). The music speeds up each level. |
| `src/main.js` | Wires everything together: keyboard, sound and the game loop. |

### Gesture tricks

- **Scale-free:** every distance is measured in *palm lengths* (wrist to the middle-finger knuckle), so gestures work whether you're near the camera or far from it.
- **Hysteresis everywhere:** columns, fists and pinches all use separate "on" and "off" thresholds, so they don't flicker at the edge.
- **Self-calibrating twist:** the angle you first raise your hand at becomes neutral, and neutral slowly drifts to follow you while you're resting. A 10° turn to the left rotates the piece anticlockwise. You have to come back to centre before the next twist counts, and turning right never triggers anything, so wobbling back can't cause a double rotation.
- **Gesture guard:** after a slam or a hold, the right hand's gestures are ignored for 600 ms. Twists also don't count while the hand is moving fast or mid-pinch, so tapping for hold can't accidentally rotate the piece. A pinch only counts while the pinky is open, so closing your hand for a slam is never mistaken for a hold.

Press **D** in game to see every live gesture value next to its threshold.

## Tech

Plain JavaScript, HTML canvas and CSS, served with Vite. No frameworks. Hand tracking uses [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) (`HandLandmarker`, GPU delegate with CPU fallback). The font is Press Start 2P from Google Fonts.
