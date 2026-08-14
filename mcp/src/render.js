'use strict';

const M = require('./machine');

/*
 * Draws a machine as SVG, matching the designer's conventions: stadium-shaped
 * states that stretch to fit their label, a double outline for accepting
 * states, arrows trimmed to the outline rather than to a bounding circle.
 *
 * This deliberately re-implements the geometry rather than importing the
 * browser code, which is bound to a canvas context for its text metrics and to
 * the DOM for everything else. The constants below are kept in step with
 * fsm.js by hand; the shared piece is the *format*, not the drawing code.
 */

const NODE_RADIUS = 26;
const TEXT_PAD_X = 14;
const ACCEPT_INSET = 6;
const FONT_SIZE = 20;
const SUB_FONT_SIZE = 14;
const SUB_DROP = 4.4;
const ARROW_SIZE = 8;
const FONT_FAMILY = 'Times New Roman, Times, serif';

/*
 * Times New Roman advance widths, per 1000 units of em. Needed because there
 * is no canvas here to measure with, and a state's width follows its label.
 * The viewer's own font engine draws the text, so a small mismatch shows up
 * only as slightly generous padding.
 */
const WIDTHS = {
  ' ': 250, '!': 333, '"': 408, '#': 500, '$': 500, '%': 833, '&': 778, "'": 180,
  '(': 333, ')': 333, '*': 500, '+': 564, ',': 250, '-': 333, '.': 250, '/': 278,
  ':': 278, ';': 278, '<': 564, '=': 564, '>': 564, '?': 444, '@': 921,
  '[': 333, '\\': 278, ']': 333, '^': 469, '_': 500, '`': 333,
  '{': 480, '|': 200, '}': 480, '~': 541,
  A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333,
  J: 389, K: 722, L: 611, M: 889, N: 722, O: 722, P: 556, Q: 722, R: 667,
  S: 556, T: 611, U: 722, V: 722, W: 944, X: 722, Y: 722, Z: 611,
  a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278,
  j: 278, k: 500, l: 278, m: 778, n: 500, o: 500, p: 500, q: 500, r: 333,
  s: 389, t: 278, u: 500, v: 500, w: 722, x: 500, y: 500, z: 444
};

function charWidth(ch, size) {
  if (ch >= '0' && ch <= '9') return size * 0.5;
  const w = WIDTHS[ch];
  if (w != null) return size * w / 1000;
  if (ch >= 'Ͱ' && ch <= 'Ͽ') return size * 0.5;   // greek
  if (ch >= '₀' && ch <= '₉') return size * 0.35;  // subscript digits
  return size * 0.5;
}

function textWidth(text, size) {
  let total = 0;
  for (const ch of text) total += charWidth(ch, size);
  return total;
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

// Mirrors the designer's rules: \greek escapes, `_x` and `_{run}` subscripts.
function labelSegments(raw) {
  const text = raw || '';
  const segments = [];
  const push = (str, sub) => {
    if (!str) return;
    const last = segments[segments.length - 1];
    if (last && last.sub === sub) last.text += str;
    else segments.push({ text: str, sub });
  };

  let i = 0;
  while (i < text.length) {
    if (text[i] === '_' && i + 1 < text.length) {
      if (text[i + 1] === '{') {
        const end = text.indexOf('}', i + 2);
        if (end >= 0) { push(M.renderLabel(text.slice(i + 2, end)), true); i = end + 1; continue; }
      } else {
        const glyph = M.renderLabel(text[i + 1]);
        push(glyph, true);
        i += 2;
        continue;
      }
    }
    if (text[i] === '\\') {
      const rest = text.slice(i);
      const rendered = M.renderLabel(rest);
      // renderLabel collapses the escape; take one glyph off the front.
      const consumed = rest.length - (rendered.length - 1);
      push(rendered[0], false);
      i += Math.max(1, consumed);
      continue;
    }
    push(text[i], false);
    i += 1;
  }
  return segments;
}

function labelWidth(raw) {
  let total = 0;
  for (const seg of labelSegments(raw)) {
    total += textWidth(seg.text, seg.sub ? SUB_FONT_SIZE : FONT_SIZE);
  }
  return total;
}

function halfWidthFor(raw) {
  return Math.max(0, labelWidth(raw) / 2 + TEXT_PAD_X - NODE_RADIUS);
}

/* ------------------------------------------------------------------ *
 * Node geometry
 * ------------------------------------------------------------------ */

function nodeShape(state) {
  return {
    x: state.x || 0,
    y: state.y || 0,
    halfWidth: halfWidthFor(state.label != null ? state.label : state.name),
    accepting: !!state.accepting
  };
}

function containsPoint(shape, px, py) {
  const cx = Math.max(shape.x - shape.halfWidth, Math.min(shape.x + shape.halfWidth, px));
  const dx = px - cx, dy = py - shape.y;
  return dx * dx + dy * dy <= NODE_RADIUS * NODE_RADIUS;
}

function boundaryToward(shape, px, py) {
  const cx = Math.max(shape.x - shape.halfWidth, Math.min(shape.x + shape.halfWidth, px));
  let dx = px - cx, dy = py - shape.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: cx + dx / len * NODE_RADIUS, y: shape.y + dy / len * NODE_RADIUS };
}

// Same bisection the app uses: correct for any outline, so the pill needs no
// special case.
function findBoundary(at, tIn, tOut, shape) {
  if (!containsPoint(shape, at(tIn).x, at(tIn).y)) return tIn;
  if (containsPoint(shape, at(tOut).x, at(tOut).y)) return tOut;
  for (let i = 0; i < 28; i++) {
    const mid = (tIn + tOut) / 2;
    const p = at(mid);
    if (containsPoint(shape, p.x, p.y)) tIn = mid; else tOut = mid;
  }
  return tOut;
}

function pillPath(x, y, halfWidth, radius) {
  const l = x - halfWidth, r = x + halfWidth;
  return `M ${n(l)} ${n(y - radius)} L ${n(r)} ${n(y - radius)} ` +
    `A ${n(radius)} ${n(radius)} 0 0 1 ${n(r)} ${n(y + radius)} ` +
    `L ${n(l)} ${n(y + radius)} ` +
    `A ${n(radius)} ${n(radius)} 0 0 1 ${n(l)} ${n(y - radius)} Z`;
}

function n(v) { return Math.round(v * 100) / 100; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render(machine, options = {}) {
  const m = M.normalize(machine);
  const shapes = new Map(m.states.map(s => [s.id, nodeShape(s)]));
  const hiStates = new Set(options.highlightStates || []);
  const hiTrans = new Set(options.highlightTransitions || []);
  const ghost = new Set(options.ghostStates || []);
  const accent = options.accent || '#1a56db';
  const dim = '#c8c8c8';
  const ink = '#111111';

  const parts = [];
  const bounds = new Bounds();

  // Transitions first, so states sit on top of their arrows.
  for (const t of m.transitions) {
    const key = `${t.from}|${t.to}`;
    const on = hiTrans.has(key) || hiTrans.has(t.id);
    const faded = ghost.has(t.from) || ghost.has(t.to);
    const colour = on ? accent : (faded ? dim : ink);
    const width = on ? 2.4 : 1.4;
    const label = t.label != null && t.label !== ''
      ? t.label : M.symbolsToLabel(t.symbols, t.epsilon);

    if (t.from === t.to) {
      drawSelfLoop(parts, bounds, shapes.get(t.from), t, label, colour, width);
    } else {
      drawLink(parts, bounds, shapes.get(t.from), shapes.get(t.to), t, label, colour, width);
    }
  }

  for (const s of m.states) {
    const shape = shapes.get(s.id);
    const on = hiStates.has(s.id) || hiStates.has(s.name);
    const faded = ghost.has(s.id);
    const colour = on ? accent : (faded ? dim : ink);
    const width = on ? 2.4 : 1.4;

    if (s.start) drawStartArrow(parts, bounds, shape, colour, width);

    if (on) {
      parts.push(`<path d="${pillPath(shape.x, shape.y, shape.halfWidth, NODE_RADIUS)}" fill="${accent}" fill-opacity="0.10" stroke="none"/>`);
    }
    parts.push(`<path d="${pillPath(shape.x, shape.y, shape.halfWidth, NODE_RADIUS)}" fill="none" stroke="${colour}" stroke-width="${width}"/>`);
    if (shape.accepting) {
      parts.push(`<path d="${pillPath(shape.x, shape.y, shape.halfWidth, NODE_RADIUS - ACCEPT_INSET)}" fill="none" stroke="${colour}" stroke-width="${width}"/>`);
    }
    bounds.add(shape.x - shape.halfWidth - NODE_RADIUS, shape.y - NODE_RADIUS);
    bounds.add(shape.x + shape.halfWidth + NODE_RADIUS, shape.y + NODE_RADIUS);

    drawLabel(parts, bounds, s.label != null ? s.label : s.name, shape.x, shape.y, colour);
  }

  const pad = options.padding != null ? options.padding : 30;
  // A caller animating a construction passes the finished machine's box, so
  // the frame does not lurch about as states appear.
  const box = options.viewBox || bounds.result(pad);
  const title = options.title
    ? `<text x="${n(box.x + box.width / 2)}" y="${n(box.y + 18)}" font-family="${FONT_FAMILY}" font-size="16" fill="#555" text-anchor="middle">${esc(options.title)}</text>`
    : '';
  if (options.title) box.y -= 4;

  const bg = options.background === null ? ''
    : `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" fill="${options.background || '#ffffff'}"/>`;

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(box.x)} ${n(box.y)} ${n(box.width)} ${n(box.height)}" width="${Math.ceil(box.width)}" height="${Math.ceil(box.height)}">\n${bg}\n${title}\n${parts.join('\n')}\n</svg>`,
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
    viewBox: box
  };
}

/*
 * Where a link runs, separated from the drawing of it, so the layout pass can
 * ask the same question the renderer will: where does this arrow actually go,
 * and where does its label land?
 */
function linkGeometry(from, to, t) {
  if (!from || !to) return null;
  const perp = t.perpendicularPart || 0;
  let at, geom;

  if (!perp) {
    at = s => ({ x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s });
    geom = { type: 'line' };
  } else {
    const par = t.parallelPart != null ? t.parallelPart : 0.5;
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const anchor = {
      x: from.x + dx * par - dy * perp / len,
      y: from.y + dy * par + dx * perp / len
    };
    const c = circleThrough(from.x, from.y, anchor.x, anchor.y, to.x, to.y);
    if (!c) {
      at = s => ({ x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s });
      geom = { type: 'line' };
    } else {
      const a0 = Math.atan2(from.y - c.y, from.x - c.x);
      const a1 = Math.atan2(to.y - c.y, to.x - c.x);
      const aa = Math.atan2(anchor.y - c.y, anchor.x - c.x);
      const forward = mod2pi(a1 - a0);
      const delta = mod2pi(aa - a0) <= forward ? forward : forward - Math.PI * 2;
      at = s => ({
        x: c.x + c.radius * Math.cos(a0 + delta * s),
        y: c.y + c.radius * Math.sin(a0 + delta * s)
      });
      geom = { type: 'arc', c, a0, delta };
    }
  }

  const t0 = findBoundary(at, 0, 1, from);
  const t1 = findBoundary(at, 1, 0, to);
  if (t1 <= t0) return null;

  const start = at(t0), end = at(t1), mid = at((t0 + t1) / 2);
  let d, endAngle, textAngle;

  if (geom.type === 'line') {
    d = `M ${n(start.x)} ${n(start.y)} L ${n(end.x)} ${n(end.y)}`;
    endAngle = Math.atan2(to.y - from.y, to.x - from.x);
    textAngle = endAngle - Math.PI / 2;
  } else {
    const { c, a0, delta } = geom;
    const from1 = a0 + delta * t0, to1 = a0 + delta * t1;
    d = arcPath(c, from1, to1, delta < 0);
    endAngle = to1 + (delta > 0 ? Math.PI / 2 : -Math.PI / 2);
    textAngle = a0 + delta * (t0 + t1) / 2;
  }
  return {
    d, start, end, mid, endAngle, textAngle, at, t0, t1,
    sample: n => {
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push(at(t0 + (t1 - t0) * (i / n)));
      return pts;
    }
  };
}

function drawLink(parts, bounds, from, to, t, label, colour, width) {
  const g = linkGeometry(from, to, t);
  if (!g) return;
  parts.push(`<path d="${g.d}" fill="none" stroke="${colour}" stroke-width="${width}"/>`);
  bounds.add(g.start.x, g.start.y); bounds.add(g.end.x, g.end.y); bounds.add(g.mid.x, g.mid.y);
  arrowHead(parts, g.end.x, g.end.y, g.endAngle, colour);
  drawLabel(parts, bounds, label, g.mid.x, g.mid.y, colour, g.textAngle, t.labelOffset);
}

function selfLoopGeometry(shape, t) {
  if (!shape) return null;
  const angle = t.anchorAngle != null ? t.anchorAngle : -Math.PI / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const edge = boundaryToward(shape, shape.x + cos * 4000, shape.y + sin * 4000);
  const radius = NODE_RADIUS * 0.78;
  const cx = edge.x + cos * radius * 0.82;
  const cy = edge.y + sin * radius * 0.82;
  const at = a => ({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });

  const STEPS = 180;
  const inside = [];
  for (let i = 0; i < STEPS; i++) {
    const p = at(i * Math.PI * 2 / STEPS);
    inside.push(containsPoint(shape, p.x, p.y));
  }
  let exit = -1, enter = -1;
  for (let i = 0; i < STEPS; i++) {
    const j = (i + 1) % STEPS;
    if (inside[i] && !inside[j]) exit = i;
    if (!inside[i] && inside[j]) enter = i;
  }

  let a0, a1;
  if (exit < 0 || enter < 0) {
    a0 = angle + Math.PI * 0.75;
    a1 = a0 + Math.PI * 2 * 0.92;
  } else {
    const refine = idx => {
      let lo = idx * Math.PI * 2 / STEPS, hi = (idx + 1) * Math.PI * 2 / STEPS;
      const loInside = inside[idx];
      for (let k = 0; k < 22; k++) {
        const mid = (lo + hi) / 2, p = at(mid);
        if (containsPoint(shape, p.x, p.y) === loInside) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    };
    a0 = refine(exit);
    a1 = refine(enter);
    if (a1 < a0) a1 += Math.PI * 2;
  }

  const midAngle = (a0 + a1) / 2;
  return {
    d: arcPath({ x: cx, y: cy, radius }, a0, a1, false),
    circle: { x: cx, y: cy, radius },
    tip: at(a1),
    endAngle: a1 + Math.PI / 2,
    mid: { x: cx + radius * Math.cos(midAngle), y: cy + radius * Math.sin(midAngle) },
    textAngle: midAngle,
    sample: n => {
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push(at(a0 + (a1 - a0) * (i / n)));
      return pts;
    }
  };
}

function drawSelfLoop(parts, bounds, shape, t, label, colour, width) {
  const g = selfLoopGeometry(shape, t);
  if (!g) return;
  parts.push(`<path d="${g.d}" fill="none" stroke="${colour}" stroke-width="${width}"/>`);
  bounds.add(g.circle.x - g.circle.radius, g.circle.y - g.circle.radius);
  bounds.add(g.circle.x + g.circle.radius, g.circle.y + g.circle.radius);
  arrowHead(parts, g.tip.x, g.tip.y, g.endAngle, colour);
  drawLabel(parts, bounds, label, g.mid.x, g.mid.y, colour, g.textAngle, t.labelOffset);
}

function drawStartArrow(parts, bounds, shape, colour, width) {
  const sx = shape.x - shape.halfWidth - NODE_RADIUS - 60;
  const sy = shape.y;
  const at = s => ({ x: sx + (shape.x - sx) * s, y: sy + (shape.y - sy) * s });
  const t1 = findBoundary(at, 1, 0, shape);
  const end = at(t1);
  parts.push(`<path d="M ${n(sx)} ${n(sy)} L ${n(end.x)} ${n(end.y)}" fill="none" stroke="${colour}" stroke-width="${width}"/>`);
  arrowHead(parts, end.x, end.y, Math.atan2(shape.y - sy, shape.x - sx), colour);
  bounds.add(sx, sy);
}

function arrowHead(parts, x, y, angle, colour) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const p1 = `${n(x)},${n(y)}`;
  const p2 = `${n(x - ARROW_SIZE * cos + ARROW_SIZE * 0.5 * sin)},${n(y - ARROW_SIZE * sin - ARROW_SIZE * 0.5 * cos)}`;
  const p3 = `${n(x - ARROW_SIZE * cos - ARROW_SIZE * 0.5 * sin)},${n(y - ARROW_SIZE * sin + ARROW_SIZE * 0.5 * cos)}`;
  parts.push(`<polygon points="${p1} ${p2} ${p3}" fill="${colour}" stroke="none"/>`);
}

// Where a label lands, given its anchor and how far the layout pass wants it
// pushed clear of whatever it was colliding with.
function labelPlacement(raw, x, y, angle, extraPush) {
  const width = labelWidth(raw);
  if (angle != null) {
    const nx = Math.cos(angle), ny = Math.sin(angle);
    const push = 8 + Math.abs(nx) * (width / 2) + Math.abs(ny) * (FONT_SIZE / 2)
      + (extraPush || 0);
    x += nx * push;
    y += ny * push;
  }
  return { x, y, width, height: FONT_SIZE };
}

function drawLabel(parts, bounds, raw, x, y, colour, angle, extraPush) {
  const segments = labelSegments(raw);
  if (!segments.length) return;
  const place = labelPlacement(raw, x, y, angle, extraPush);
  const width = place.width;
  x = place.x;
  y = place.y;

  let cursor = x - width / 2;
  for (const seg of segments) {
    const size = seg.sub ? SUB_FONT_SIZE : FONT_SIZE;
    parts.push(`<text x="${n(cursor)}" y="${n(y + (seg.sub ? SUB_DROP : 0))}" font-family="${FONT_FAMILY}" font-size="${size}" fill="${colour}" text-anchor="start" dominant-baseline="central">${esc(seg.text)}</text>`);
    cursor += textWidth(seg.text, size);
  }
  bounds.add(x - width / 2, y - FONT_SIZE / 2);
  bounds.add(x + width / 2, y + FONT_SIZE / 2);
}

function arcPath(c, a0, a1, ccw) {
  let delta = ccw ? -mod2pi(a0 - a1) : mod2pi(a1 - a0);
  if (Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6) delta = ccw ? -Math.PI * 2 : Math.PI * 2;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI * 0.99)));
  const sweep = delta > 0 ? 1 : 0;
  let d = `M ${n(c.x + c.radius * Math.cos(a0))} ${n(c.y + c.radius * Math.sin(a0))}`;
  for (let i = 1; i <= steps; i++) {
    const a = a0 + delta * i / steps;
    d += ` A ${n(c.radius)} ${n(c.radius)} 0 0 ${sweep} ${n(c.x + c.radius * Math.cos(a))} ${n(c.y + c.radius * Math.sin(a))}`;
  }
  return d;
}

function circleThrough(x1, y1, x2, y2, x3, y3) {
  const a = x1 - x2, b = y1 - y2, c = x1 - x3, d = y1 - y3;
  const det = 2 * (a * d - b * c);
  if (Math.abs(det) < 1e-9) return null;
  const s1 = x1 * x1 + y1 * y1, s2 = x2 * x2 + y2 * y2, s3 = x3 * x3 + y3 * y3;
  const cx = (d * (s1 - s2) - b * (s1 - s3)) / det;
  const cy = (a * (s1 - s3) - c * (s1 - s2)) / det;
  return { x: cx, y: cy, radius: Math.hypot(cx - x1, cy - y1) };
}

function mod2pi(a) {
  const r = a % (Math.PI * 2);
  return r < 0 ? r + Math.PI * 2 : r;
}

class Bounds {
  constructor() {
    this.minX = Infinity; this.minY = Infinity;
    this.maxX = -Infinity; this.maxY = -Infinity;
  }
  add(x, y) {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }
  result(pad) {
    if (this.minX === Infinity) return { x: 0, y: 0, width: 200, height: 120 };
    return {
      x: this.minX - pad, y: this.minY - pad,
      width: (this.maxX - this.minX) + pad * 2,
      height: (this.maxY - this.minY) + pad * 2
    };
  }
}

/*
 * Every label's rectangle, and every state's, in one list. The layout pass
 * uses this to find overlaps: it asks the renderer where things will actually
 * end up rather than estimating, so the two can never disagree.
 */
function labelBoxes(machine) {
  const m = M.normalize(machine);
  const shapes = new Map(m.states.map(s => [s.id, nodeShape(s)]));
  const boxes = [];

  for (const s of m.states) {
    const shape = shapes.get(s.id);
    boxes.push({
      kind: 'state', id: s.id,
      x: shape.x, y: shape.y,
      width: (shape.halfWidth + NODE_RADIUS) * 2,
      height: NODE_RADIUS * 2
    });
  }

  // `index` identifies the transition back in the caller's own machine.
  // normalize() rebuilds transition objects, so the object here is a copy and
  // comparing it by identity against the caller's would silently never match.
  m.transitions.forEach((t, index) => {
    const raw = t.label != null && t.label !== ''
      ? t.label : M.symbolsToLabel(t.symbols, t.epsilon);
    const g = t.from === t.to
      ? selfLoopGeometry(shapes.get(t.from), t)
      : linkGeometry(shapes.get(t.from), shapes.get(t.to), t);
    if (!g) return;
    const place = labelPlacement(raw, g.mid.x, g.mid.y, g.textAngle, t.labelOffset);
    boxes.push({
      kind: 'label', transition: t, index,
      x: place.x, y: place.y,
      // Where the label sits relative to its own arrow. The gap between the
      // two is what ties one to the other by eye.
      anchor: { x: g.mid.x, y: g.mid.y },
      width: Math.max(place.width, 6) + 4,
      height: place.height + 2,
      empty: !raw
    });
  });
  return boxes;
}

/*
 * The polyline each arrow actually traces, with a bounding box. The layout
 * pass uses these to keep arrows off labels and to find where two of them
 * cross, again by asking the renderer rather than approximating the curve.
 */
function transitionPaths(machine, samples = 20) {
  const m = M.normalize(machine);
  const shapes = new Map(m.states.map(s => [s.id, nodeShape(s)]));
  const out = [];

  m.transitions.forEach((t, index) => {
    const g = t.from === t.to
      ? selfLoopGeometry(shapes.get(t.from), t)
      : linkGeometry(shapes.get(t.from), shapes.get(t.to), t);
    if (!g) return;
    const points = g.sample(samples);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    out.push({ transition: t, index, points, box: { minX, minY, maxX, maxY } });
  });
  return out;
}

function overlap(a, b) {
  const dx = Math.abs(a.x - b.x) - (a.width + b.width) / 2;
  const dy = Math.abs(a.y - b.y) - (a.height + b.height) / 2;
  return dx < 0 && dy < 0 ? Math.min(-dx, -dy) : 0;
}

module.exports = {
  render, labelWidth, labelSegments, halfWidthFor, labelBoxes, overlap,
  linkGeometry, selfLoopGeometry, nodeShape, labelPlacement, transitionPaths,
  NODE_RADIUS
};
