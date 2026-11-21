// handmenu.js — big hover-to-select buttons for the games' menu screens
// (start, paused, game over). Hover a hand over a button for DWELL_MS and it
// fires. No hand shape is needed, so it never clashes with game gestures and
// it works with arm (pose) tracking as well as hand tracking.
//
// Usage:
//   const menu = createHandMenu([{ id, side: 'left' | 'right', label, action }]);
//   menu.feed(points[, now]) // on each new tracking result: [{ x, y }] in mirrored camera space (0..1)
//   menu.frame(now, visible) // every animation frame
//   menu.setLabel(id, text)

const DWELL_MS = 1000;
const LOST_MS = 400; // hide a cursor this long after its hand disappears
const SMOOTH = 0.4; // cursor EMA weight for the newest position
const RING = 151; // circumference of the progress ring (r = 24)

// The middle 60% of the camera view covers the whole page, so you don't
// have to reach the edges of the frame.
function toPage(v, size) {
  return Math.min(1, Math.max(0, (v - 0.2) / 0.6)) * size;
}

export function createHandMenu(items) {
  const root = document.createElement('div');
  root.className = 'hand-menu';
  root.hidden = true;

  const buttons = items.map((item) => {
    const el = document.createElement('button');
    el.className = `hand-menu-btn ${item.side}`;
    el.innerHTML = `<span class="label"></span><span class="hint">hover a hand here</span><i class="fill"></i>`;
    el.querySelector('.label').textContent = item.label;
    el.addEventListener('click', () => item.action());
    root.append(el);
    return { ...item, el, fill: el.querySelector('.fill') };
  });

  // Up to two cursors (one per tracked hand / wrist).
  const cursors = [0, 1].map(() => {
    const el = document.createElement('div');
    el.className = 'hand-menu-cursor';
    el.hidden = true;
    el.innerHTML = '<svg viewBox="0 0 60 60"><circle class="ring-bg" cx="30" cy="30" r="24"/><circle class="ring" cx="30" cy="30" r="24"/></svg>';
    root.append(el);
    return { el, ring: el.querySelector('.ring'), x: null, y: null, seen: -Infinity };
  });

  document.body.append(root);

  let shown = false;
  let target = null; // button being hovered
  let since = 0;
  // A button that must be left before it can fire: the one just fired, or one
  // a hand was already resting on when the menu appeared (e.g. the right hand
  // near the edge when the game ends).
  let blocked = null;
  let justShown = false;

  function reset() {
    target = null;
    for (const b of buttons) {
      b.el.classList.remove('hover');
      b.fill.style.transform = 'scaleX(0)';
    }
    for (const c of cursors) c.ring.style.strokeDashoffset = String(RING);
  }

  function buttonAt(x, y) {
    for (const b of buttons) {
      const r = b.el.getBoundingClientRect();
      // A generous margin makes the buttons easy to hit with a wobbly hand.
      if (x > r.left - 30 && x < r.right + 30 && y > r.top - 40 && y < r.bottom + 40) return b;
    }
    return null;
  }

  return {
    feed(points, now = performance.now()) {
      // Keep cursor identity stable: each point goes to the nearest live
      // cursor, so when one hand leaves, the other cursor doesn't jump.
      const targets = points.slice(0, 2).map((p) => ({ tx: toPage(p.x, innerWidth), ty: toPage(p.y, innerHeight) }));
      const isLive = (c) => now - c.seen <= LOST_MS && c.x !== null;
      const cost = (c, t) => (isLive(c) ? Math.hypot(c.x - t.tx, c.y - t.ty) : 1e6); // prefer live cursors
      // Try both pairings of (up to) two points with the two cursors; keep the cheaper.
      const pairings = [[0, 1], [1, 0]].map((order) => targets.map((t, k) => [cursors[order[k]], t]));
      const total = (pairs) => pairs.reduce((sum, [c, t]) => sum + cost(c, t), 0);
      const best = total(pairings[0]) <= total(pairings[1]) ? pairings[0] : pairings[1];
      for (const [c, { tx, ty }] of best) {
        const fresh = now - c.seen > LOST_MS || c.x === null;
        c.x = fresh ? tx : c.x + SMOOTH * (tx - c.x);
        c.y = fresh ? ty : c.y + SMOOTH * (ty - c.y);
        c.seen = now;
      }
    },

    frame(now, visible) {
      if (visible !== shown) {
        shown = visible;
        root.hidden = !visible;
        reset();
        justShown = visible;
      }
      if (!visible) return;

      // Which button (if any) is a live cursor over?
      let hovered = null;
      let hoverCursor = null;
      for (const c of cursors) {
        const live = now - c.seen < LOST_MS && c.x !== null;
        c.el.hidden = !live;
        if (!live) continue;
        c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
        const b = buttonAt(c.x, c.y);
        if (b && !hovered) [hovered, hoverCursor] = [b, c];
      }

      if (justShown) {
        blocked = hovered;
        justShown = false;
      }
      if (blocked && hovered !== blocked) blocked = null;
      if (hovered === blocked) hovered = null;

      if (hovered !== target) {
        reset();
        target = hovered;
        since = now;
      }
      if (!target) return;

      const progress = Math.min(1, (now - since) / DWELL_MS);
      target.el.classList.add('hover');
      target.fill.style.transform = `scaleX(${progress})`;
      hoverCursor.ring.style.strokeDashoffset = String(RING * (1 - progress));
      if (progress >= 1) {
        const fire = target.action;
        blocked = target; // move off the button before it can fire again
        reset();
        fire();
      }
    },

    setLabel(id, text) {
      const b = buttons.find((b) => b.id === id);
      const label = b?.el.querySelector('.label');
      if (label && label.textContent !== text) label.textContent = text;
    },
  };
}
