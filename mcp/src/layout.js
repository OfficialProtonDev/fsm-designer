'use strict';

const M = require('./machine');

/*
 * Positions for a machine that was computed rather than drawn.
 *
 * States are laid out in columns by their distance from the start, which suits
 * automata specifically: reading left to right follows the machine consuming
 * input. A plain force layout would scatter that ordering.
 */

const COLUMN_GAP = 200;
const ROW_GAP = 130;
const CLEARANCE = 46;   // how close an arrow may pass to an uninvolved state

function layout(machine, options = {}) {
  const m = M.normalize(machine);
  if (!m.states.length) return m;

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
  let orphanColumn = Math.max(-1, ...[...depth.values()]) + 1;
  for (const s of m.states) {
    if (!depth.has(s.id)) depth.set(s.id, orphanColumn);
  }

  const columns = new Map();
  for (const s of m.states) {
    const d = depth.get(s.id);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(s);
  }

  const colGap = options.columnGap || COLUMN_GAP;
  const rowGap = options.rowGap || ROW_GAP;
  const keys = [...columns.keys()].sort((a, b) => a - b);

  for (const d of keys) {
    const members = columns.get(d);
    const height = (members.length - 1) * rowGap;
    members.forEach((s, i) => {
      s.x = d * colGap;
      s.y = i * rowGap - height / 2;
    });
  }

  // Centre the whole thing on the origin, which is where the designer's
  // default view sits.
  const xs = m.states.map(s => s.x);
  const ys = m.states.map(s => s.y);
  const dx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const dy = (Math.min(...ys) + Math.max(...ys)) / 2;
  for (const s of m.states) { s.x -= dx; s.y -= dy; }

  assignCurves(m);
  return m;
}

/*
 * Curve handles, so the drawing is readable rather than merely correct:
 * a pair of opposite arrows bows apart instead of overlapping, and self-loops
 * point away from the neighbours.
 */
function assignCurves(m) {
  const byId = new Map(m.states.map(s => [s.id, s]));
  const pairSeen = new Map();

  for (const t of m.transitions) {
    if (t.from === t.to) continue;
    const forward = `${t.from} ${t.to}`;
    const backward = `${t.to} ${t.from}`;
    if (pairSeen.has(backward)) {
      t.perpendicularPart = 46;
      const other = pairSeen.get(backward);
      if (other.perpendicularPart == null || other.perpendicularPart === 0) {
        other.perpendicularPart = 46;
      }
    } else if (t.perpendicularPart == null) {
      t.perpendicularPart = 0;
    }
    if (t.parallelPart == null) t.parallelPart = 0.5;
    pairSeen.set(forward, t);
  }

  // A long straight arrow between distant columns will run straight through
  // whatever sits between them. Bow those aside, away from the obstruction.
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

  const loopCount = new Map();
  for (const t of m.transitions) {
    if (t.from !== t.to) continue;
    const n = loopCount.get(t.from) || 0;
    loopCount.set(t.from, n + 1);
    // First loop on top, then below, then to the sides.
    const angles = [-Math.PI / 2, Math.PI / 2, 0, Math.PI];
    t.anchorAngle = angles[n % angles.length];
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

module.exports = { layout, assignCurves, pointToSegment };
