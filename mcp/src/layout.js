'use strict';

const M = require('./machine');
const R = require('./render');

/*
 * Positions for a machine that was computed rather than drawn.
 *
 * States go in columns by their distance from the start, which suits automata
 * specifically: reading left to right follows the machine consuming input. A
 * general force layout would scatter that ordering and make the diagram harder
 * to follow, not easier.
 *
 * On top of that ordering the pass tries to make the result actually legible:
 * rows are reordered to pull connected states level with each other, columns
 * are spaced by how wide their labels really are, self-loops point somewhere
 * nothing else is using, and labels are pushed apart until they stop
 * colliding. Each of those is a separate small pass over the same positions.
 */

const MIN_COLUMN_GAP = 130;   // clear space between one column and the next
const ROW_GAP = 132;
const CLEARANCE = 46;         // how close an arrow may pass to an uninvolved state
const LABEL_STEP = 9;         // how far to nudge a colliding label each round
const MAX_LABEL_PUSH = 46;

function layout(machine, options = {}) {
  const m = M.normalize(machine);
  if (!m.states.length) return m;

  const columns = assignColumns(m);
  orderRows(m, columns);
  place(m, columns, options);
  assignCurves(m);
  routeAroundStates(m);
  separateLabels(m);
  centre(m);
  return m;
}

/* ------------------------------------------------------------------ *
 * Columns: distance from the start
 * ------------------------------------------------------------------ */

function assignColumns(m) {
  const index = M.transitionIndex(m);
  const start = M.startState(m);
  const depth = new Map();

  if (start) {
    depth.set(start.id, 0);
    const queue = [start.id];
    while (queue.length) {
      const id = queue.shift();
      const row = index.move.get(id) || new Map();
      const next = [...row.values()].flat().concat(index.eps.get(id) || []);
      for (const to of next) {
        if (depth.has(to)) continue;
        depth.set(to, depth.get(id) + 1);
        queue.push(to);
      }
    }
  }
  // Anything the start cannot reach still needs somewhere to sit.
  const orphanColumn = Math.max(-1, ...[...depth.values()]) + 1;
  for (const s of m.states) if (!depth.has(s.id)) depth.set(s.id, orphanColumn);

  const columns = new Map();
  for (const s of m.states) {
    const d = depth.get(s.id);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(s);
  }
  return [...columns.keys()].sort((a, b) => a - b).map(k => columns.get(k));
}

/* ------------------------------------------------------------------ *
 * Row order: pull connected states level with each other
 * ------------------------------------------------------------------ */

/*
 * The barycentre heuristic. Repeatedly place each state at the average height
 * of its neighbours in the column alongside, sweeping forwards then back.
 * It is the standard way to cut edge crossings in a layered drawing, and
 * crossings are most of what makes one of these look tangled.
 */
function orderRows(m, columns) {
  const neighbours = new Map(m.states.map(s => [s.id, []]));
  for (const t of m.transitions) {
    if (t.from === t.to) continue;
    neighbours.get(t.from).push(t.to);
    neighbours.get(t.to).push(t.from);
  }

  const rank = new Map();
  columns.forEach(col => col.forEach((s, i) => rank.set(s.id, i)));

  const sweep = (order) => {
    for (const columnIndex of order) {
      const col = columns[columnIndex];
      const fixed = new Set();
      const near = columns[columnIndex - 1] || columns[columnIndex + 1] || [];
      near.forEach(s => fixed.add(s.id));

      const score = new Map();
      for (const s of col) {
        const ranks = neighbours.get(s.id)
          .filter(id => fixed.has(id))
          .map(id => rank.get(id))
          .filter(r => r != null);
        // No neighbour to follow: keep where it is, so ordering stays stable.
        score.set(s.id, ranks.length
          ? ranks.reduce((a, b) => a + b, 0) / ranks.length
          : rank.get(s.id));
      }
      col.sort((a, b) => score.get(a.id) - score.get(b.id));
      col.forEach((s, i) => rank.set(s.id, i));
    }
  };

  const forwards = columns.map((_, i) => i);
  for (let pass = 0; pass < 4; pass++) {
    sweep(pass % 2 ? [...forwards].reverse() : forwards);
  }
}

/* ------------------------------------------------------------------ *
 * Coordinates
 * ------------------------------------------------------------------ */

function place(m, columns, options) {
  const rowGap = options.rowGap || ROW_GAP;
  const gap = options.columnGap != null ? options.columnGap : MIN_COLUMN_GAP;

  // Column x follows the widths actually drawn, so a column of long names
  // does not crowd the one after it.
  const widths = columns.map(col =>
    Math.max(...col.map(s => (R.halfWidthFor(s.label != null ? s.label : s.name)
      + R.NODE_RADIUS) * 2)));

  let x = 0;
  columns.forEach((col, i) => {
    const half = widths[i] / 2;
    x += half;
    const height = (col.length - 1) * rowGap;
    col.forEach((s, j) => {
      s.x = x;
      s.y = j * rowGap - height / 2;
    });
    x += half + gap;
  });
}

function centre(m) {
  const xs = m.states.map(s => s.x);
  const ys = m.states.map(s => s.y);
  const dx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const dy = (Math.min(...ys) + Math.max(...ys)) / 2;
  for (const s of m.states) { s.x -= dx; s.y -= dy; }
}

/* ------------------------------------------------------------------ *
 * Curves
 * ------------------------------------------------------------------ */

function assignCurves(m) {
  const pairSeen = new Map();

  for (const t of m.transitions) {
    if (t.from === t.to) continue;
    const backward = `${t.to} ${t.from}`;
    if (pairSeen.has(backward)) {
      // Both bow by the same amount; because the two run in opposite
      // directions, that puts them on opposite sides of the line.
      t.perpendicularPart = 46;
      const other = pairSeen.get(backward);
      if (!other.perpendicularPart) other.perpendicularPart = 46;
    } else if (t.perpendicularPart == null) {
      t.perpendicularPart = 0;
    }
    if (t.parallelPart == null) t.parallelPart = 0.5;
    pairSeen.set(`${t.from} ${t.to}`, t);
  }

  assignSelfLoops(m);
  return m;
}

/*
 * A self-loop is put wherever there is room: the direction furthest from any
 * arrow already arriving at or leaving the state. Cycling blindly through
 * top-bottom-left-right, as this used to, drops loops straight on top of the
 * incoming arrows.
 */
function assignSelfLoops(m) {
  const byId = new Map(m.states.map(s => [s.id, s]));
  const used = new Map(m.states.map(s => [s.id, []]));

  for (const t of m.transitions) {
    if (t.from === t.to) continue;
    const a = byId.get(t.from), b = byId.get(t.to);
    if (!a || !b) continue;
    used.get(t.from).push(Math.atan2(b.y - a.y, b.x - a.x));
    used.get(t.to).push(Math.atan2(a.y - b.y, a.x - b.x));
  }
  // The start arrow comes in from the left, so that side is spoken for.
  for (const s of m.states) if (s.start) used.get(s.id).push(Math.PI);

  const taken = new Map(m.states.map(s => [s.id, []]));
  for (const t of m.transitions) {
    if (t.from !== t.to) continue;
    const candidates = [-Math.PI / 2, Math.PI / 2, 0, Math.PI,
      -Math.PI / 4, -Math.PI * 3 / 4, Math.PI / 4, Math.PI * 3 / 4];
    const busy = used.get(t.from).concat(taken.get(t.from));

    let best = candidates[0], bestScore = -Infinity;
    for (const angle of candidates) {
      const score = busy.length
        ? Math.min(...busy.map(b => Math.abs(angleGap(angle, b))))
        : Math.PI;
      // Ties go to the earlier candidate, keeping "up" the default.
      if (score > bestScore + 1e-6) { bestScore = score; best = angle; }
    }
    t.anchorAngle = best;
    taken.get(t.from).push(best);
  }
}

function angleGap(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/*
 * A long straight arrow between distant columns runs through whatever sits
 * between them. Bow those aside, away from the obstruction.
 */
function routeAroundStates(m) {
  const byId = new Map(m.states.map(s => [s.id, s]));
  for (const t of m.transitions) {
    if (t.from === t.to || t.perpendicularPart) continue;
    const a = byId.get(t.from), b = byId.get(t.to);
    if (!a || !b) continue;

    let worst = 0, side = 1;
    for (const s of m.states) {
      if (s === a || s === b) continue;
      const d = pointToSegment(s.x, s.y, a.x, a.y, b.x, b.y);
      if (d.distance > CLEARANCE || !d.between) continue;
      if (CLEARANCE - d.distance > worst) {
        worst = CLEARANCE - d.distance;
        side = d.cross >= 0 ? -1 : 1;    // bow to the far side of the blocker
      }
    }
    if (worst > 0) t.perpendicularPart = side * (CLEARANCE + 26);
  }
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

/*
 * Push labels out along their own normal until they stop overlapping each
 * other and stop sitting on top of a state. The renderer is asked where each
 * label really lands, so this cannot drift out of step with the drawing.
 *
 * Each round nudges only the worst offender in a colliding pair, which
 * converges without labels chasing each other back and forth.
 */
function separateLabels(m) {
  for (const t of m.transitions) if (t.labelOffset == null) t.labelOffset = 0;

  for (let round = 0; round < 14; round++) {
    const boxes = R.labelBoxes(m);
    const labels = boxes.filter(b => b.kind === 'label' && !b.empty);
    const states = boxes.filter(b => b.kind === 'state');
    let moved = false;

    for (let i = 0; i < labels.length; i++) {
      let worst = 0;

      for (const s of states) {
        worst = Math.max(worst, R.overlap(labels[i], s));
      }
      for (let j = 0; j < labels.length; j++) {
        if (i === j) continue;
        worst = Math.max(worst, R.overlap(labels[i], labels[j]));
      }

      if (worst > 0.5) {
        const t = labels[i].transition;
        if (t.labelOffset < MAX_LABEL_PUSH) {
          t.labelOffset = Math.min(MAX_LABEL_PUSH, t.labelOffset + LABEL_STEP);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return m;
}

// Distance from a point to a segment, plus which side it falls on and whether
// it is alongside the segment rather than off one of its ends.
function pointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return { distance: Infinity, between: false, cross: 0 };
  const t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  const cx = x1 + dx * t, cy = y1 + dy * t;
  return {
    distance: Math.hypot(px - cx, py - cy),
    between: t > 0.08 && t < 0.92,
    cross: dx * (py - y1) - dy * (px - x1)
  };
}

module.exports = {
  layout, assignCurves, separateLabels, orderRows, pointToSegment
};
