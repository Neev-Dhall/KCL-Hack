<div align="center">

# ✋ HAND STACK ✋

**A neon falling-block puzzle you play with your bare hands.**

*An arcade idea from the 1980s, rebuilt for 2026 with real-time hand tracking in the browser.*

![JavaScript](https://img.shields.io/badge/JavaScript-vanilla-f7df1e?style=flat-square&logo=javascript&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-8-646cff?style=flat-square&logo=vite&logoColor=white)
![MediaPipe](https://img.shields.io/badge/MediaPipe-Hand_Landmarker-0097a7?style=flat-square)
![Web Audio](https://img.shields.io/badge/Web_Audio-synthesised-ff2bd6?style=flat-square)
![No frameworks](https://img.shields.io/badge/frameworks-none-00e5ff?style=flat-square)

**Retro Remix track · KCL Tech First Year Hack · built with JetBrains Air**

<img src="docs/media/demo.gif" alt="Hand Stack gameplay: pieces fall, line clears flash SINGLE, hold and next previews update" width="720">

[▶ Watch the full gameplay clip (42 s)](docs/media/gameplay.mp4) · [Quick start](#-quick-start) · [Controls](#-controls) · [How it works](#-how-it-works)

</div>

---

## 🕹️ What is it?

Hand Stack is a falling-block puzzle in its own neon arcade style, but there's **no controller**. Your webcam watches both hands:

- your **left hand** steers the falling piece across the board and drops it faster
- your **right hand** rotates it, slams it down and puts it on hold

Hand tracking runs **entirely in the browser** with Google's MediaPipe. Nothing gets installed, and no video ever leaves your machine. If there's no camera, the whole game still plays on the keyboard.

### Features

- 🖐️ **Two-handed gesture control:** six gestures across two hands, with live skeleton overlays (cyan = move hand, pink = action hand)
- 🎯 **Column bands:** ten numbered bands on the camera view map your palm straight onto the board, with hysteresis so the piece doesn't jitter between columns
- 🔁 **Self-calibrating wrist twist:** whatever angle you hold your hand at becomes "neutral", with a live dial gauge
- 👌 **Robust pinch detection** that can't be confused with a fist
- 🧩 **Proper puzzle rules:** 7-bag randomiser, wall kicks in both directions, ghost piece, hold, 3-piece preview, levels and speed-up
- 🎵 **Synthesised audio:** an original chiptune loop that speeds up each level, plus sound effects, all generated with the Web Audio API (no audio files)
- 🛠️ **Live debug panel (D):** every gesture value next to its threshold, plus the tracker's frame rate
- ♿ **Left-handed mode (S)** and a **full keyboard fallback**
- 💻 Fits a 1366×768 laptop screen

---

## 📸 Screenshots

| Start screen and gesture guide | Mid-game |
|---|---|
| <img src="docs/media/start-screen.png" alt="Start screen with illustrated guide to the six gestures"> | <img src="docs/media/gameplay.png" alt="Gameplay: board with ghost piece and SLAM flash, hold and next previews, score panel, camera view with column bands and controls reminder"> |

| Debug panel (press D) |
|---|
| <img src="docs/media/debug-panel.png" alt="Debug panel listing every live gesture value next to its threshold, and the tracker running on GPU at 47 fps"> |

> **About these captures:** the screenshots and the gameplay clip were recorded in headless Chrome. The game was driven by scripted **keyboard** input, and the camera was a blank synthetic feed. That's why the camera panel shows the bands and dial but no hands, and why the status lines read "not seen".
>
> <!-- TEAM: to add a real hand-tracking clip, open this README on GitHub, click edit, drag an .mp4 into the editor
>      (GitHub uploads it and inserts a playable link), and paste that link under "Hand tracking in action" below. -->

### Hand tracking in action

*Clip coming soon: recorded on a real webcam during the hackathon.*

---

## 🚀 Quick start

You need [Node.js](https://nodejs.org/) 20+, a webcam and an internet connection. The hand-tracking model loads from a CDN.

```bash
git clone https://github.com/Neev-Dhall/KCL-Hack.git
cd KCL-Hack
npm install
npm run dev
```

Open the URL Vite prints (usually **http://localhost:5173**) in **Google Chrome**, allow camera access, then **make a fist with your right hand** or press **Enter** to start.

> 🔊 Sound and music start after your first click or key press, because browsers block audio until then.
> 📷 If the camera is blocked, the game says so and carries on with the keyboard.

---

## 🎮 Controls

Left hand = **MOVE** hand (cyan). Right hand = **ACTION** hand (pink). Press **S** to swap them for left-handers.

### Hands

| Hand | Gesture | Action |
|---|---|---|
| ✋ Left | Hold your palm over one of the 10 column bands on the camera view | Piece slides to that column |
| ✊ Left | Hold a closed fist | Soft drop |
| 👌 Left | Tap thumb and index together | Rotate 90° **clockwise** |
| 🔄 Right | Palm toward the camera, turn it **left** like a dial, then back to centre | Rotate 90° **anticlockwise** |
| 👌 Right | Tap thumb and index together | **Hold** the piece |
| ✊ Right | Close into a fist | **Slam** (hard drop); also starts the game |

### Keyboard

| Key | Action | Key | Action |
|---|---|---|---|
| ← → | Move | P | Pause |
| ↓ | Soft drop | Enter | Start / restart |
| ↑ or X | Rotate clockwise | S | Swap hand roles |
| Z | Rotate anticlockwise | D | Debug panel |
| Space | Hard drop | M | Mute (effects and music) |
| C | Hold | | |

### Scoring

| Clear | Points |
|---|---|
| 1 line (SINGLE) | 100 × level |
| 2 lines (DOUBLE) | 300 × level |
| 3 lines (TRIPLE) | 500 × level |
| 4 lines (QUAD!) | 800 × level |
| Soft drop / hard drop | +1 / +2 per row |

You go up a level every 10 lines. Gravity starts at 800 ms per row and gets 70 ms faster each level, down to a minimum of 80 ms.

---

## 🧠 How it works

```mermaid
flowchart LR
    CAM[📷 Webcam] --> MP["MediaPipe HandLandmarker<br/>21 landmarks × 2 hands<br/>(GPU, CPU fallback)"]
    MP --> ROLES["Assign roles<br/>left on screen = MOVE<br/>right on screen = ACTION"]
    ROLES --> MEAS["Measure in palm lengths<br/>finger extension · curl<br/>pinch gap · knuckle angle"]
    MEAS --> GEST["Gesture state machines<br/>hysteresis · arming<br/>cooldowns · motion guard"]
    GEST -->|"moveTo · rotate · hold<br/>hardDrop · setSoftDrop"| GAME["game.js<br/>rules + canvas renderer"]
    KEYS[⌨️ Keyboard] --> GAME
    GAME -->|events| SND["sound.js<br/>SFX + chiptune"]
```

The code is split so each file has one job, and the hand code can only reach the game through its public API:

| File | Job |
|---|---|
| [`src/game.js`](src/game.js) | Game rules and drawing only: board, 7-bag randomiser, wall kicks, scoring, levels, the neon canvas renderer and CRT scanlines. It knows nothing about cameras. |
| [`src/hands.js`](src/hands.js) | Camera, MediaPipe hand tracking and gesture detection. It only calls the API that `game.js` exports. **Every gesture threshold is in one commented block at the top of the file.** |
| [`src/sound.js`](src/sound.js) | Sound effects and an original 4-bar chiptune loop (Am–F–C–G), played by a small step sequencer on the Web Audio clock. |
| [`src/main.js`](src/main.js) | Wires it all together: keyboard, sound, music, screens and the game loop. |

### Gesture tricks

- **Scale-free:** every distance is measured in *palm lengths* (wrist to the middle-finger knuckle). Gestures work the same close to the camera or far away.
- **Hysteresis everywhere:** columns, fists and pinches each have separate "on" and "off" thresholds, so nothing flickers at the edge.
- **Self-calibrating twist:** the angle you first raise your hand at becomes neutral, and neutral slowly follows your hand while it rests. A 10° turn left rotates once. You come back to centre to re-arm, and turning right never triggers anything, so wobbling back can't double-rotate.
- **Pinch vs fist:** a pinch is an "OK sign": thumb and index touching while the other three fingers stay straight. It has to *start* from an open thumb and hold for 2 frames. A fist curls those fingers, so closing or opening a fist can never count as a pinch.
- **Motion guard:** after a slam or hold, the action hand is ignored for 600 ms. Twists don't count while the hand is moving fast or mid-pinch.

### Tuning

All thresholds live at the top of [`src/hands.js`](src/hands.js). Press **D** in game to see each live value next to its threshold, so you can tune a gesture by watching the numbers.

| Gesture | Key values |
|---|---|
| Column bands | 5–47% of frame width · switch 0.2 of a band past the edge |
| Fist (soft drop / slam) | curl < 1.05 on · > 1.4 off / re-arm |
| Pinch | gap < 0.45 · arm > 0.6 · other fingers avg > 1.15 · 2 frames |
| Twist | 10° left fires · ±4° re-arms · EMA α 0.5 · `TWIST_SIGN` flips direction |
| Motion guard | > 0.5 palm lengths in 250 ms · 600 ms cooldown |

---

## 🧰 Tech

- **Plain JavaScript, HTML canvas and CSS**, served with **Vite**. No frameworks.
- **[MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)** `HandLandmarker` (`float16` model, `VIDEO` mode, 2 hands), loaded from jsDelivr.
- **Web Audio API** for every sound and the music.
- **[Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P)** from Google Fonts.

## 🙌 Credits

Built for the **Retro Remix** track at **KCL Tech First Year Hack**, with **JetBrains Air**.
The visual style, palette, sounds and music are original to this project.
