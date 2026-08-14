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
const MAX_LABEL_PUSH = 60;
const CROSS_CLEARANCE = 62;   // how near a state two arrows may cross

function layout(machine, options = {}) {
  const m = M.normalize(machine);
  if (!m.states.length) return m;

  const columns = assignColumns(m);
  orderRows(m, columns);
  place(m, columns, options);
  assignCurves(m);
  routeAroundStates(m);
  untangleNearStates(m);
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
 * Arrows crossing each other
 * ------------------------------------------------------------------ */

/*
 * Two arrows crossing in open space reads fine -- it is unavoidable in most
 * machines. Two crossing right beside a state does not: at that distance the
 * eye cannot tell which arrow ends at the state and which is passing over it,
 * which is exactly the information the diagram exists to convey. So only
 * crossings near a state are counted, and only those are worth moving.
 */
function crossingsNearStates(m, paths) {
  paths = paths || R.transitionPaths(m);
  const bad = [];

  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i], b = paths[j];
      if (a.box.maxX < b.box.minX || b.box.maxX < a.box.minX ||
          a.box.maxY < b.box.minY || b.box.maxY < a.box.minY) continue;

      // Arrows meeting at a shared endpoint touch there by design.
      const shares = a.transition.from === b.transition.from ||
        a.transition.from === b.transition.to ||
        a.transition.to === b.transition.from ||
        a.transition.to === b.transition.to;

      let found = null;
      for (let p = 0; p < a.points.length - 1 && !found; p++) {
        for (let q = 0; q < b.points.length - 1; q++) {
          const hit = segmentsCross(a.points[p], a.points[p + 1],
            b.points[q], b.points[q + 1]);
          if (hit) { found = hit; break; }
        }
      }
      if (!found) continue;

      let nearest = Infinity;
      for (const s of m.states) {
        nearest = Math.min(nearest, Math.hypot(found.x - s.x, found.y - s.y));
      }
      // Where two arrows share an endpoint, only a crossing well away from
      // that state is a genuine tangle.
      const limit = shares ? CROSS_CLEARANCE * 0.6 : CROSS_CLEARANCE;
      if (nearest < limit) {
        bad.push({ aIndex: a.index, bIndex: b.index, at: found, distance: nearest });
      }
    }
  }
  return bad;
}

function segmentsCross(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + d1x * t, y: p1.y + d1y * t };
}

// Does this arrow's path run into a state that is not one of its endpoints?
function pathClearOfStates(m, index) {
  const t = m.transitions[index];
  const entry = R.transitionPaths(m).find(p => p.index === index);
  if (!entry || !t) return true;
  for (const s of m.states) {
    if (s.id === t.from || s.id === t.to) continue;
    const half = R.halfWidthFor(s.label != null ? s.label : s.name);
    for (const p of entry.points) {
      const cx = Math.max(s.x - half, Math.min(s.x + half, p.x));
      if (Math.hypot(p.x - cx, p.y - s.y) < R.NODE_RADIUS + 6) return false;
    }
  }
  return true;
}

/*
 * Nudge the curve on whichever arrows are involved in the most crossings,
 * keeping a change only when it genuinely reduces the count. A small hill
 * climb rather than anything cleverer: the search space is a handful of bow
 * amounts per arrow, and these machines are small.
 */
function untangleNearStates(m) {
  if (m.transitions.length > 40) return m;   // too big to be worth the search
  const CANDIDATES = [0, 46, -46, 70, -70, 100, -100, 130, -130];

  for (let round = 0; round < 5; round++) {
    const bad = crossingsNearStates(m);
    if (!bad.length) break;

    const blame = new Map();
    for (const c of bad) {
      blame.set(c.aIndex, (blame.get(c.aIndex) || 0) + 1);
      blame.set(c.bIndex, (blame.get(c.bIndex) || 0) + 1);
    }
    const worstFirst = [...blame.entries()]
      .sort((x, y) => y[1] - x[1]).map(e => e[0])
      // self-loops move by angle, not by bowing
      .filter(i => m.transitions[i] && m.transitions[i].from !== m.transitions[i].to)
      .slice(0, 4);

    let improved = false;
    for (const index of worstFirst) {
      const t = m.transitions[index];
      const original = t.perpendicularPart || 0;
      let best = original;
      let bestScore = bad.length;

      for (const candidate of CANDIDATES) {
        if (candidate === original) continue;
        t.perpendicularPart = candidate;
        if (!pathClearOfStates(m, index)) continue;
        const score = crossingsNearStates(m).length;
        // Prefer fewer crossings, and among equals the gentler curve.
        if (score < bestScore ||
            (score === bestScore && Math.abs(candidate) < Math.abs(best))) {
          bestScore = score;
          best = candidate;
        }
      }
      t.perpendicularPart = best;
      if (best !== original) { improved = true; break; }
    }
    if (!improved) break;
  }
  return m;
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
/*
 * Each label is tried at a series of offsets along its own normal and left
 * wherever it collides with least. Offsets go both ways, because a label
 * boxed in on the outside of a curve is often perfectly clear on the inside,
 * and pushing outward alone would just run it into something else.
 *
 * Candidates are ordered by how far they move the label, and ties go to the
 * smaller move, so labels stay near the arrow they belong to.
 */
function separateLabels(m) {
  for (const t of m.transitions) if (t.labelOffset == null) t.labelOffset = 0;

  const candidates = [0];
  for (let d = LABEL_STEP; d <= MAX_LABEL_PUSH; d += LABEL_STEP) candidates.push(d, -d);

  // Arrow paths do not depend on where labels sit, so they are found once.
  const paths = R.transitionPaths(m);

  for (let round = 0; round < 6; round++) {
    let moved = false;

    m.transitions.forEach((t, index) => {
      const hasLabel = (t.label != null && t.label !== '') || t.symbols.length || t.epsilon;
      if (!hasLabel) return;

      const original = t.labelOffset;
      let best = original, bestScore = Infinity;

      for (const candidate of candidates) {
        t.labelOffset = candidate;
        const score = labelClash(m, index, paths);
        if (score < bestScore ||
            (score === bestScore && Math.abs(candidate) < Math.abs(best))) {
          bestScore = score;
          best = candidate;
        }
        if (score === 0) break;      // ordered by distance, so this is the best
      }
      t.labelOffset = best;
      if (best !== original) moved = true;
    });
    if (!moved) break;
  }
  return m;
}

// How badly the label of transition `index` collides with anything else.
function labelClash(m, index, paths) {
  const boxes = R.labelBoxes(m);
  const mine = boxes.find(b => b.kind === 'label' && b.index === index);
  if (!mine || mine.empty) return 0;

  let score = 0;
  for (const b of boxes) {
    if (b === mine) continue;
    if (b.kind === 'label' && b.empty) continue;
    score += R.overlap(mine, b);
  }
  // An arrow drawn straight through its own text is as bad as two labels on
  // top of each other. A label's own arrow is excluded: it runs alongside by
  // construction.
  for (const p of paths) {
    if (p.index === index) continue;
    if (pathCrossesBox(p, mine)) score += 12;
  }
  return score;
}

function pathCrossesBox(path, box) {
  const left = box.x - box.width / 2, right = box.x + box.width / 2;
  const top = box.y - box.height / 2, bottom = box.y + box.height / 2;
  if (path.box.maxX < left || path.box.minX > right ||
      path.box.maxY < top || path.box.minY > bottom) return false;
  for (const p of path.points) {
    if (p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) return true;
  }
  return false;
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
  layout, assignCurves, separateLabels, orderRows, pointToSegment,
  crossingsNearStates, untangleNearStates, pathCrossesBox
};
