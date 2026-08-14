/*
 * Finite State Machine Designer
 *
 * A from-scratch rebuild of the classic canvas FSM editor with two changes:
 *   - states are stadium ("pill") shaped so long labels fit inside them
 *   - the canvas is pannable and zoomable, with a Clear All button
 */
'use strict';

var NODE_RADIUS = 26;          // half-height of a state, and cap radius
var TEXT_PAD_X = 14;           // horizontal breathing room around a label
var ACCEPT_INSET = 6;          // gap between the two rings of an accept state
var HIT_PADDING = 8;           // extra slack when clicking links
var SNAP_PADDING = 8;          // alignment snapping while dragging
var ARROW_SIZE = 8;
var FONT_SIZE = 20;
var FONT = FONT_SIZE + 'px "Times New Roman", serif';
var SUB_FONT_SIZE = Math.round(FONT_SIZE * 0.7);
var SUB_FONT = SUB_FONT_SIZE + 'px "Times New Roman", serif';
var SUB_DROP = FONT_SIZE * 0.22;   // how far a subscript sits below the baseline
var STORAGE_KEY = 'fsm-designer-v1';

var nodes = [];
var links = [];

var canvas, ctx, cssWidth = 0, cssHeight = 0;
var measureCtx = document.createElement('canvas').getContext('2d');
measureCtx.font = FONT;

var view = { x: -400, y: -300, scale: 1 };   // world point shown at screen (0,0)

var ACCENT = '#1a56db';

var selectedObject = null;   // node or link being edited (drives the caret)
var selection = [];          // nodes highlighted for a group move
var rubberBand = null;       // right-drag selection box, in world coordinates
var currentLink = null;      // link being created by shift-drag
var movingObject = false;
var panning = false;
var panStart = null;
var originalClick = null;
var caretVisible = true;
var shiftPressed = false;

var caretIndex = 0;        // caret position, counted in glyphs
var selectAnchor = null;   // other end of a highlighted run, or null
var textEditing = false;   // true once the caret has been placed in a label
var textDragging = false;  // dragging out a highlight inside a label
var textClipboard = '';

/* ------------------------------------------------------------------ *
 * Small math helpers
 * ------------------------------------------------------------------ */

var TWO_PI = Math.PI * 2;

function mod2pi(a) {
  a = a % TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}

function dist(x1, y1, x2, y2) {
  var dx = x2 - x1, dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// Circle passing through three points, or null when they are collinear.
function circleThroughPoints(x1, y1, x2, y2, x3, y3) {
  var a = x1 - x2, b = y1 - y2, c = x1 - x3, d = y1 - y3;
  var det = 2 * (a * d - b * c);
  if (Math.abs(det) < 1e-9) return null;
  var s1 = x1 * x1 + y1 * y1, s2 = x2 * x2 + y2 * y2, s3 = x3 * x3 + y3 * y3;
  var cx = (d * (s1 - s2) - b * (s1 - s3)) / det;
  var cy = (a * (s1 - s3) - c * (s1 - s2)) / det;
  return { x: cx, y: cy, radius: dist(cx, cy, x1, y1) };
}

/*
 * Where along a path does it cross a node's outline?
 *
 * `at(t)` walks the path, `t0` is known to be inside the node and `t1`
 * outside. Bisection keeps this correct for any node shape, which is what
 * lets pill-shaped states work without special-cased intersection math.
 */
function findBoundary(at, t0, t1, node) {
  var p0 = at(t0);
  if (!node.containsPoint(p0.x, p0.y)) return t0;
  var p1 = at(t1);
  if (node.containsPoint(p1.x, p1.y)) return t1;
  for (var i = 0; i < 32; i++) {
    var mid = (t0 + t1) / 2;
    var p = at(mid);
    if (node.containsPoint(p.x, p.y)) t0 = mid; else t1 = mid;
  }
  return t1;
}

/* ------------------------------------------------------------------ *
 * Label text: greek shortcuts and numeric subscripts
 * ------------------------------------------------------------------ */

var GREEK = {
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
  Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ',
  Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ',
  Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω'
};

function greekify(text) {
  var out = text;
  for (var name in GREEK) {
    out = out.split('\\' + name).join(GREEK[name]);
  }
  return out;
}

// Longest first, so \omicron is not mistaken for \omi.
var GREEK_NAMES = Object.keys(GREEK).sort(function (a, b) {
  return b.length - a.length;
});

// Reads one visible glyph starting at `i`: either a \greek escape or a
// single character.
function readGlyph(raw, i) {
  if (raw.charAt(i) === '\\') {
    for (var k = 0; k < GREEK_NAMES.length; k++) {
      var name = GREEK_NAMES[k];
      if (raw.substr(i + 1, name.length) === name) {
        return { display: GREEK[name], next: i + 1 + name.length };
      }
    }
  }
  return { display: raw.charAt(i), next: i + 1 };
}

/*
 * Breaks a raw label into one unit per *visible* glyph, each remembering where
 * it came from in the raw string. That mapping is what lets a click land the
 * caret in the middle of a label: `\alpha` is six raw characters but one
 * glyph, and the caret only ever sits between glyphs.
 *
 * Subscripts are drawn smaller and lowered rather than swapped for Unicode
 * subscript characters, because Unicode only defines those for the digits and
 * a scattering of lowercase letters -- there is no subscript b, c, d, q, y, z
 * or any capital at all. Drawing them means any character can be a subscript.
 *
 * `S_0` takes the next glyph; `q_{start}` takes a braced run.
 *
 * `insertAt` is where typed text goes to land before this glyph, which for a
 * braced run means inside the braces. Units in a braced run also carry the
 * span of the whole construct so deleting the last member takes the braces.
 */
function scanUnits(raw) {
  var units = [];
  var i = 0;

  while (i < raw.length) {
    if (raw.charAt(i) === '_' && i + 1 < raw.length) {
      if (raw.charAt(i + 1) === '{') {
        var end = raw.indexOf('}', i + 2);
        if (end >= 0) {
          var group = [];
          var j = i + 2;
          while (j < end) {
            var inner = readGlyph(raw, j);
            group.push({ display: inner.display, sub: true, insertAt: j,
              delStart: j, delEnd: inner.next,
              groupStart: i, groupEnd: end + 1, groupIndex: group.length });
            j = inner.next;
          }
          for (var g = 0; g < group.length; g++) group[g].groupCount = group.length;
          units = units.concat(group);
          i = end + 1;
          continue;
        }
        // unclosed brace: fall through and treat the underscore literally
      } else {
        var one = readGlyph(raw, i + 1);
        units.push({ display: one.display, sub: true, insertAt: i,
          delStart: i, delEnd: one.next });
        i = one.next;
        continue;
      }
    }
    var plain = readGlyph(raw, i);
    units.push({ display: plain.display, sub: false, insertAt: i,
      delStart: i, delEnd: plain.next });
    i = plain.next;
  }
  return units;
}

function glyphFont(sub) { return sub ? SUB_FONT : FONT; }

function glyphWidth(display, sub) {
  measureCtx.font = glyphFont(sub);
  return measureCtx.measureText(display).width;
}

/*
 * Positions every glyph and groups runs of like kind for drawing. Segment
 * widths are summed from their glyphs rather than measured whole, so a
 * caret drawn at a glyph boundary lands exactly where that glyph starts.
 */
function labelLayout(raw) {
  var units = scanUnits(raw);
  var segments = [];
  var x = 0;

  for (var i = 0; i < units.length; i++) {
    var u = units[i];
    u.width = glyphWidth(u.display, u.sub);
    u.x = x;
    x += u.width;

    var last = segments[segments.length - 1];
    if (last && last.sub === u.sub) {
      last.text += u.display;
      last.width += u.width;
    } else {
      segments.push({ text: u.display, sub: u.sub, x: u.x, width: u.width });
    }
  }
  return { units: units, segments: segments, width: x };
}

function parseLabel(raw) { return labelLayout(raw).segments; }

function segmentFont(segment) { return glyphFont(segment.sub); }

function segmentWidth(segment) {
  return segment.width != null ? segment.width
                               : glyphWidth(segment.text, segment.sub);
}

function segmentsWidth(segments) {
  var total = 0;
  for (var i = 0; i < segments.length; i++) total += segmentWidth(segments[i]);
  return total;
}

// Rebuilds raw source from a run of glyphs, re-encoding greek and subscripts.
// Going through the glyphs rather than slicing the original string means the
// result is always well formed, whatever bracing the user originally typed.
function unitsToRaw(units, from, to) {
  var out = '';
  var i = from;
  while (i < to) {
    if (!units[i].sub) { out += encodeGlyph(units[i].display); i++; continue; }
    var run = '';
    while (i < to && units[i].sub) { run += encodeGlyph(units[i].display); i++; }
    out += run.length === 1 ? '_' + run : '_{' + run + '}';
  }
  return out;
}

function encodeGlyph(display) {
  for (var name in GREEK) {
    if (GREEK[name] === display) return '\\' + name;
  }
  return display;
}

function rawWithout(units, from, to) {
  return unitsToRaw(units, 0, from) + unitsToRaw(units, to, units.length);
}

var LATEX_ESCAPES = {
  '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '_': '\\_',
  '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}', '\\': '\\textbackslash{}'
};

// The same characters again, using the spellings that are valid inside math
// mode -- subscripts are emitted as $_{...}$, so their contents are already
// in math and the \text... forms above would not compile there.
var LATEX_MATH_ESCAPES = {
  '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '_': '\\_',
  '{': '\\{', '}': '\\}', '~': '\\sim ',
  '^': '\\wedge ', '\\': '\\backslash '
};

/*
 * For LaTeX export. Text is emitted in text mode, with only greek letters
 * wrapped in math mode: text mode keeps the upright roman the canvas draws
 * (math mode would italicise a name like WaitingForInput and space it as a
 * product of variables), and it lets stray characters like % or & be escaped
 * the ordinary way.
 */
function textToLatex(text, inMath) {
  var escapes = inMath ? LATEX_MATH_ESCAPES : LATEX_ESCAPES;
  var out = '';
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    var found = null;
    for (var name in GREEK) {
      if (GREEK[name] === ch) { found = name; break; }
    }
    if (found) {
      out += inMath ? '\\' + found + ' ' : '$\\' + found + '$';
      continue;
    }
    out += escapes.hasOwnProperty(ch) ? escapes[ch] : ch;
  }
  return out;
}

function measureLabel(text) {
  return segmentsWidth(parseLabel(text));
}

/* ------------------------------------------------------------------ *
 * Node (a state)
 * ------------------------------------------------------------------ */

function Node(x, y) {
  this.x = x;
  this.y = y;
  this.text = '';
  this.isAcceptState = false;
  this.halfWidth = 0;        // half-length of the straight section of the pill
  this.mouseOffsetX = 0;
  this.mouseOffsetY = 0;
}

// The pill grows sideways only as far as the label needs; a short label
// leaves halfWidth at 0, which draws an ordinary circle.
Node.prototype.updateSize = function () {
  var w = measureLabel(this.text);
  this.halfWidth = Math.max(0, w / 2 + TEXT_PAD_X - NODE_RADIUS);
};

Node.prototype.setMouseStart = function (x, y) {
  this.mouseOffsetX = this.x - x;
  this.mouseOffsetY = this.y - y;
};

Node.prototype.setAnchorPoint = function (x, y) {
  this.x = x + this.mouseOffsetX;
  this.y = y + this.mouseOffsetY;
};

// Closest point on the pill's centre line -- the basis of all its geometry.
Node.prototype.spinePoint = function (x, y) {
  return {
    x: Math.max(this.x - this.halfWidth, Math.min(this.x + this.halfWidth, x)),
    y: this.y
  };
};

Node.prototype.containsPoint = function (x, y, padding) {
  var p = this.spinePoint(x, y);
  var r = NODE_RADIUS + (padding || 0);
  var dx = x - p.x, dy = y - p.y;
  return dx * dx + dy * dy <= r * r;
};

// Point on the outline in the direction of (x, y).
Node.prototype.boundaryToward = function (x, y) {
  var p = this.spinePoint(x, y);
  var dx = x - p.x, dy = y - p.y;
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) { dx = 1; dy = 0; len = 1; }
  return { x: p.x + dx / len * NODE_RADIUS, y: p.y + dy / len * NODE_RADIUS };
};

function tracePill(c, x, y, halfWidth, radius) {
  c.beginPath();
  c.moveTo(x - halfWidth, y - radius);
  c.lineTo(x + halfWidth, y - radius);
  c.arc(x + halfWidth, y, radius, -Math.PI / 2, Math.PI / 2, false);
  c.lineTo(x - halfWidth, y + radius);
  c.arc(x - halfWidth, y, radius, Math.PI / 2, Math.PI * 1.5, false);
  c.closePath();
}

Node.prototype.bounds = function () {
  var reach = this.halfWidth + NODE_RADIUS;
  return {
    x0: this.x - reach, y0: this.y - NODE_RADIUS,
    x1: this.x + reach, y1: this.y + NODE_RADIUS
  };
};

Node.prototype.draw = function (c, owner) {
  tracePill(c, this.x, this.y, this.halfWidth, NODE_RADIUS);
  c.stroke();
  if (this.isAcceptState) {
    tracePill(c, this.x, this.y, this.halfWidth, NODE_RADIUS - ACCEPT_INSET);
    c.stroke();
  }
  drawLabel(c, this.text, this.x, this.y, null, owner);
};

// Where this object's label sits, for click hit-testing.
Node.prototype.labelPlace = function () {
  return labelPlacement(this.text, this.x, this.y, null);
};

/* ------------------------------------------------------------------ *
 * Link (state -> state)
 * ------------------------------------------------------------------ */

function Link(a, b) {
  this.nodeA = a;
  this.nodeB = b;
  this.text = '';
  this.parallelPart = 0.5;      // position of the curve handle along AB
  this.perpendicularPart = 0;   // and away from it, in pixels; 0 == straight
}

Link.prototype.getAnchorPoint = function () {
  var a = this.nodeA, b = this.nodeB;
  var dx = b.x - a.x, dy = b.y - a.y;
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  return {
    x: a.x + dx * this.parallelPart - dy * this.perpendicularPart / len,
    y: a.y + dy * this.parallelPart + dx * this.perpendicularPart / len
  };
};

Link.prototype.setAnchorPoint = function (x, y) {
  var a = this.nodeA, b = this.nodeB;
  var dx = b.x - a.x, dy = b.y - a.y;
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  this.parallelPart = (dx * (x - a.x) + dy * (y - a.y)) / (len * len);
  this.perpendicularPart = (dx * (y - a.y) - dy * (x - a.x)) / len;
  if (Math.abs(this.perpendicularPart) < SNAP_PADDING) {
    this.perpendicularPart = 0;   // snap back to a straight line
    this.parallelPart = 0.5;
  }
};

// Resolves the link into the piece of curve actually drawn between the two
// outlines, plus the tangent at the arrow end and a spot for the label.
Link.prototype.geometry = function () {
  var a = this.nodeA, b = this.nodeB;
  var at, t0, t1;

  if (this.perpendicularPart === 0) {
    at = function (t) {
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    };
    t0 = findBoundary(at, 0, 1, a);
    t1 = findBoundary(at, 1, 0, b);
    if (t1 <= t0) return null;
    var start = at(t0), end = at(t1), mid = at((t0 + t1) / 2);
    var ang = Math.atan2(b.y - a.y, b.x - a.x);
    return {
      type: 'line', start: start, end: end, at: at, t0: t0, t1: t1,
      endAngle: ang,
      textX: mid.x, textY: mid.y, textAngle: ang - Math.PI / 2
    };
  }

  var anchor = this.getAnchorPoint();
  var circle = circleThroughPoints(a.x, a.y, anchor.x, anchor.y, b.x, b.y);
  if (!circle) {
    this.perpendicularPart = 0;
    return this.geometry();
  }
  var a0 = Math.atan2(a.y - circle.y, a.x - circle.x);
  var aEnd = Math.atan2(b.y - circle.y, b.x - circle.x);
  var aAnchor = Math.atan2(anchor.y - circle.y, anchor.x - circle.x);
  var forward = mod2pi(aEnd - a0);
  // Sweep whichever way actually passes through the handle.
  var delta = mod2pi(aAnchor - a0) <= forward ? forward : forward - TWO_PI;

  at = function (t) {
    var ang = a0 + delta * t;
    return {
      x: circle.x + circle.radius * Math.cos(ang),
      y: circle.y + circle.radius * Math.sin(ang)
    };
  };
  t0 = findBoundary(at, 0, 1, a);
  t1 = findBoundary(at, 1, 0, b);
  if (t1 <= t0) return null;

  var endAng = a0 + delta * t1;
  var midAng = a0 + delta * (t0 + t1) / 2;
  return {
    type: 'arc', circle: circle, from: a0 + delta * t0, to: endAng,
    reversed: delta < 0, at: at, t0: t0, t1: t1,
    endAngle: endAng + (delta > 0 ? Math.PI / 2 : -Math.PI / 2),
    textX: circle.x + circle.radius * Math.cos(midAng),
    textY: circle.y + circle.radius * Math.sin(midAng),
    textAngle: midAng
  };
};

function drawLinkGeometry(c, g) {
  c.beginPath();
  if (g.type === 'line') {
    c.moveTo(g.start.x, g.start.y);
    c.lineTo(g.end.x, g.end.y);
  } else {
    c.arc(g.circle.x, g.circle.y, g.circle.radius, g.from, g.to, g.reversed);
  }
  c.stroke();
  var tip = g.type === 'line' ? g.end : g.at(g.t1);
  drawArrow(c, tip.x, tip.y, g.endAngle);
}

Link.prototype.draw = function (c, owner) {
  var g = this.geometry();
  if (!g) return;
  drawLinkGeometry(c, g);
  drawLabel(c, this.text, g.textX, g.textY, g.textAngle, owner);
};

Link.prototype.containsPoint = function (x, y) {
  var g = this.geometry();
  return g ? pathHasPoint(g, x, y) : false;
};

/* ------------------------------------------------------------------ *
 * SelfLink (state -> itself)
 * ------------------------------------------------------------------ */

function SelfLink(node, mouse) {
  this.node = node;
  this.anchorAngle = -Math.PI / 2;
  this.text = '';
  if (mouse) this.setAnchorPoint(mouse.x, mouse.y);
}

SelfLink.prototype.setAnchorPoint = function (x, y) {
  this.anchorAngle = Math.atan2(y - this.node.y, x - this.node.x);
  // snap to the four compass directions
  var snapped = Math.round(this.anchorAngle / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(this.anchorAngle - snapped) < 0.1) this.anchorAngle = snapped;
};

SelfLink.prototype.geometry = function () {
  var node = this.node;
  var cos = Math.cos(this.anchorAngle), sin = Math.sin(this.anchorAngle);
  var edge = node.boundaryToward(node.x + cos * 4000, node.y + sin * 4000);
  var radius = NODE_RADIUS * 0.78;
  var cx = edge.x + cos * radius * 0.82;
  var cy = edge.y + sin * radius * 0.82;

  var at = function (ang) {
    return { x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) };
  };

  // Walk the loop and keep the part that lies outside the state.
  var STEPS = 180, inside = [], i;
  for (i = 0; i < STEPS; i++) {
    var p = at(i * TWO_PI / STEPS);
    inside.push(node.containsPoint(p.x, p.y));
  }
  var exitIdx = -1, enterIdx = -1;
  for (i = 0; i < STEPS; i++) {
    var j = (i + 1) % STEPS;
    if (inside[i] && !inside[j]) exitIdx = i;
    if (!inside[i] && inside[j]) enterIdx = i;
  }

  var from, to;
  if (exitIdx < 0 || enterIdx < 0) {
    from = this.anchorAngle + Math.PI * 0.75;
    to = from + TWO_PI * 0.92;
  } else {
    var refine = function (idx) {
      var lo = idx * TWO_PI / STEPS, hi = (idx + 1) * TWO_PI / STEPS;
      var loInside = inside[idx];
      for (var k = 0; k < 24; k++) {
        var mid = (lo + hi) / 2, q = at(mid);
        if (node.containsPoint(q.x, q.y) === loInside) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    };
    from = refine(exitIdx);
    to = refine(enterIdx);
    if (to < from) to += TWO_PI;
  }

  var tip = at(to);
  var midAng = (from + to) / 2;
  return {
    type: 'arc', circle: { x: cx, y: cy, radius: radius },
    from: from, to: to, reversed: false,
    at: function (t) { return at(from + (to - from) * t); },
    t0: 0, t1: 1,
    endAngle: to + Math.PI / 2,
    tip: tip,
    textX: cx + radius * Math.cos(midAng),
    textY: cy + radius * Math.sin(midAng),
    textAngle: midAng
  };
};

SelfLink.prototype.draw = function (c, owner) {
  var g = this.geometry();
  c.beginPath();
  c.arc(g.circle.x, g.circle.y, g.circle.radius, g.from, g.to, false);
  c.stroke();
  drawArrow(c, g.tip.x, g.tip.y, g.endAngle);
  drawLabel(c, this.text, g.textX, g.textY, g.textAngle, owner);
};

SelfLink.prototype.containsPoint = function (x, y) {
  return pathHasPoint(this.geometry(), x, y);
};

/* ------------------------------------------------------------------ *
 * StartLink (arrow into a state from nowhere)
 * ------------------------------------------------------------------ */

function StartLink(node, start) {
  this.node = node;
  this.deltaX = -80;
  this.deltaY = 0;
  this.text = '';
  if (start) this.setAnchorPoint(start.x, start.y);
}

StartLink.prototype.setAnchorPoint = function (x, y) {
  this.deltaX = x - this.node.x;
  this.deltaY = y - this.node.y;
  if (Math.abs(this.deltaX) < SNAP_PADDING) this.deltaX = 0;
  if (Math.abs(this.deltaY) < SNAP_PADDING) this.deltaY = 0;
};

StartLink.prototype.geometry = function () {
  var node = this.node;
  var sx = node.x + this.deltaX, sy = node.y + this.deltaY;
  var at = function (t) {
    return { x: sx + (node.x - sx) * t, y: sy + (node.y - sy) * t };
  };
  var t1 = findBoundary(at, 1, 0, node);
  var end = at(t1);
  var ang = Math.atan2(node.y - sy, node.x - sx);
  return {
    type: 'line', start: { x: sx, y: sy }, end: end, at: at, t0: 0, t1: t1,
    endAngle: ang,
    textX: sx, textY: sy, textAngle: ang + Math.PI
  };
};

StartLink.prototype.draw = function (c, owner) {
  var g = this.geometry();
  drawLinkGeometry(c, g);
  drawLabel(c, this.text, g.textX, g.textY, g.textAngle, owner);
};

StartLink.prototype.containsPoint = function (x, y) {
  return pathHasPoint(this.geometry(), x, y);
};

/* ------------------------------------------------------------------ *
 * TemporaryLink (the rubber band while shift-dragging)
 * ------------------------------------------------------------------ */

function TemporaryLink(from, to) {
  this.from = from;
  this.to = to;
}

TemporaryLink.prototype.draw = function (c) {
  c.beginPath();
  c.moveTo(this.from.x, this.from.y);
  c.lineTo(this.to.x, this.to.y);
  c.stroke();
  drawArrow(c, this.to.x, this.to.y,
    Math.atan2(this.to.y - this.from.y, this.to.x - this.from.x));
};

/* ------------------------------------------------------------------ *
 * Shared drawing
 * ------------------------------------------------------------------ */

// All three link kinds put their label at the anchor their geometry reports.
function linkLabelPlace() {
  var g = this.geometry();
  return g ? labelPlacement(this.text, g.textX, g.textY, g.textAngle) : null;
}
Link.prototype.labelPlace = linkLabelPlace;
SelfLink.prototype.labelPlace = linkLabelPlace;
StartLink.prototype.labelPlace = linkLabelPlace;

/*
 * Finds a label under the pointer. Arrow labels sit off to the side of the
 * line, so they are not otherwise clickable at all -- without this, the only
 * way to reach an arrow's text was to select the line and backspace to it.
 */
function labelAt(x, y) {
  var all = nodes.concat(links);
  for (var i = all.length - 1; i >= 0; i--) {
    var obj = all[i];
    if (!obj.text || !obj.labelPlace) continue;
    var place = obj.labelPlace();
    if (!place) continue;
    var halfW = place.layout.width / 2 + 3;
    var halfH = FONT_SIZE / 2 + 4;
    if (Math.abs(x - place.x) <= halfW && Math.abs(y - place.y) <= halfH) {
      return { object: obj, place: place };
    }
  }
  return null;
}

function pathHasPoint(g, x, y) {
  if (!g) return false;
  var steps = 64, best = Infinity;
  for (var i = 0; i <= steps; i++) {
    var p = g.at(g.t0 + (g.t1 - g.t0) * (i / steps));
    var d = dist(p.x, p.y, x, y);
    if (d < best) best = d;
  }
  return best < HIT_PADDING;
}

function drawArrow(c, x, y, angle) {
  var cos = Math.cos(angle), sin = Math.sin(angle);
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x - ARROW_SIZE * cos + ARROW_SIZE * 0.5 * sin,
           y - ARROW_SIZE * sin - ARROW_SIZE * 0.5 * cos);
  c.lineTo(x - ARROW_SIZE * cos - ARROW_SIZE * 0.5 * sin,
           y - ARROW_SIZE * sin + ARROW_SIZE * 0.5 * cos);
  c.closePath();
  c.fill();
}

/*
 * Draws a label centred on (x, y). When `angle` is given the label is
 * nudged along that direction far enough to clear the line it belongs to.
 */
/*
 * Places a label's runs. Renderers that want the label whole -- TikZ, which
 * has real subscripts of its own -- implement drawSegments; a plain canvas
 * context falls through to positioning each run here.
 */
function drawSegments(c, segments, centreX, y, width) {
  if (c.drawSegments) { c.drawSegments(segments, centreX, y, width); return; }
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  var cursor = centreX - width / 2;
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    c.font = segmentFont(seg);
    c.fillText(seg.text, cursor, y + (seg.sub ? SUB_DROP : 0));
    cursor += segmentWidth(seg);
  }
}

/*
 * Where a label actually sits, given the anchor its owner hands over. Both
 * drawing and click hit-testing go through this so the box the mouse tests
 * against is exactly the box that was drawn.
 */
function labelPlacement(rawText, x, y, angle) {
  var layout = labelLayout(rawText);

  if (angle != null) {
    var nx = Math.cos(angle), ny = Math.sin(angle);
    var push = 6 + Math.abs(nx) * (layout.width / 2) + Math.abs(ny) * (FONT_SIZE / 2);
    x += nx * push;
    y += ny * push;
  }
  return { x: Math.round(x), y: Math.round(y), layout: layout };
}

// x of a caret sitting before glyph `index`.
function caretX(place, index) {
  var units = place.layout.units;
  var left = place.x - place.layout.width / 2;
  if (index >= units.length) return left + place.layout.width;
  return left + units[index].x;
}

// Nearest glyph boundary to a given x -- the caret never lands inside a glyph.
function caretIndexAtX(place, px) {
  var units = place.layout.units;
  var best = 0, bestDist = Infinity;
  for (var k = 0; k <= units.length; k++) {
    var d = Math.abs(px - caretX(place, k));
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return best;
}

function drawLabel(c, rawText, x, y, angle, owner) {
  var place = labelPlacement(rawText, x, y, angle);
  var layout = place.layout;
  var editing = owner && owner === selectedObject && !c.isExporter;

  if (editing && hasTextRange()) {
    var r = textRange();
    var x0 = caretX(place, r.from), x1 = caretX(place, r.to);
    var fill = c.fillStyle;
    c.fillStyle = 'rgba(26, 86, 219, 0.22)';
    c.fillRect(x0, place.y - FONT_SIZE / 2 - 2,
               x1 - x0, FONT_SIZE + SUB_DROP + 4);
    c.fillStyle = fill;
  }

  if (layout.segments.length) {
    drawSegments(c, layout.segments, place.x, place.y, layout.width);
  }

  if (editing && textEditing && caretVisible) {
    var cx = caretX(place, caretIndex);
    c.beginPath();
    c.moveTo(cx, place.y - FONT_SIZE / 2);
    c.lineTo(cx, place.y + FONT_SIZE / 2);
    c.stroke();
  } else if (editing && !textEditing && caretVisible) {
    // Not yet clicked into: the caret rests after the last glyph, as before.
    var ex = place.x + layout.width / 2 + 1;
    c.beginPath();
    c.moveTo(ex, place.y - FONT_SIZE / 2);
    c.lineTo(ex, place.y + FONT_SIZE / 2);
    c.stroke();
  }
}

// Renders the whole diagram through any ctx-like renderer.
function drawDiagram(c, options) {
  options = options || {};
  var showSelection = !!options.showSelection;
  var i;

  c.lineWidth = 1;
  c.font = FONT;

  for (i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    // Everything in the group is highlighted, but only the one being edited
    // gets a caret.
    var on = showSelection &&
      (node === selectedObject || selection.indexOf(node) >= 0);
    c.strokeStyle = c.fillStyle = on ? ACCENT : '#000000';
    node.draw(c, showSelection ? node : null);
  }
  for (i = 0; i < links.length; i++) {
    var link = links[i];
    var lon = showSelection && link === selectedObject;
    c.strokeStyle = c.fillStyle = lon ? ACCENT : '#000000';
    link.draw(c, showSelection ? link : null);
  }
  if (currentLink) {
    c.strokeStyle = c.fillStyle = '#000000';
    currentLink.draw(c, false);
  }
}

function drawGrid() {
  if (view.scale < 0.45) return;
  var step = 25;
  var x0 = Math.floor(view.x / step) * step;
  var y0 = Math.floor(view.y / step) * step;
  var x1 = view.x + cssWidth / view.scale;
  var y1 = view.y + cssHeight / view.scale;
  ctx.fillStyle = '#e2e2e2';
  var r = 1 / view.scale;
  for (var x = x0; x < x1; x += step) {
    for (var y = y0; y < y1; y += step) {
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
  }
}

function draw() {
  var dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.save();
  ctx.translate(-view.x * view.scale, -view.y * view.scale);
  ctx.scale(view.scale, view.scale);
  drawGrid();
  ctx.lineJoin = 'round';
  drawDiagram(ctx, { showSelection: true });
  drawRubberBand();
  ctx.restore();
}

function rubberBandRect() {
  return {
    x: Math.min(rubberBand.x0, rubberBand.x1),
    y: Math.min(rubberBand.y0, rubberBand.y1),
    width: Math.abs(rubberBand.x1 - rubberBand.x0),
    height: Math.abs(rubberBand.y1 - rubberBand.y0)
  };
}

function drawRubberBand() {
  if (!rubberBand) return;
  var r = rubberBandRect();
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = 'rgba(26, 86, 219, 0.08)';
  ctx.lineWidth = 1 / view.scale;
  ctx.setLineDash([4 / view.scale, 3 / view.scale]);
  ctx.fillRect(r.x, r.y, r.width, r.height);
  ctx.strokeRect(r.x, r.y, r.width, r.height);
  ctx.restore();
}

// Anything the box touches is picked up, which reads as more responsive than
// requiring a state to be fully enclosed.
function applyRubberBand() {
  var r = rubberBandRect();
  var picked = rubberBand.add ? selection.slice() : [];
  for (var i = 0; i < nodes.length; i++) {
    var b = nodes[i].bounds();
    var hit = b.x0 <= r.x + r.width && b.x1 >= r.x &&
              b.y0 <= r.y + r.height && b.y1 >= r.y;
    if (hit && picked.indexOf(nodes[i]) < 0) picked.push(nodes[i]);
  }
  selection = picked;
  // A single pick doubles as an edit target so you can just start typing.
  focusObject(selection.length === 1 ? selection[0] : null);
}

/* ------------------------------------------------------------------ *
 * Hit testing and coordinates
 * ------------------------------------------------------------------ */

function toWorld(e) {
  var rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / view.scale + view.x,
    y: (e.clientY - rect.top) / view.scale + view.y
  };
}

function objectAt(x, y) {
  var i;
  for (i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].containsPoint(x, y)) return nodes[i];
  }
  for (i = links.length - 1; i >= 0; i--) {
    if (links[i].containsPoint(x, y)) return links[i];
  }
  return null;
}

function nodeAt(x, y) {
  for (var i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].containsPoint(x, y)) return nodes[i];
  }
  return null;
}

function snapNode(node) {
  for (var i = 0; i < nodes.length; i++) {
    var other = nodes[i];
    if (other === node) continue;
    if (Math.abs(node.x - other.x) < SNAP_PADDING) node.x = other.x;
    if (Math.abs(node.y - other.y) < SNAP_PADDING) node.y = other.y;
  }
}

/* ------------------------------------------------------------------ *
 * View controls
 * ------------------------------------------------------------------ */

function setScale(newScale, screenX, screenY) {
  newScale = Math.max(0.2, Math.min(4, newScale));
  if (newScale === view.scale) return;
  var rect = canvas.getBoundingClientRect();
  var sx = screenX == null ? cssWidth / 2 : screenX - rect.left;
  var sy = screenY == null ? cssHeight / 2 : screenY - rect.top;
  // keep the world point under the cursor pinned to the cursor
  view.x += sx / view.scale - sx / newScale;
  view.y += sy / view.scale - sy / newScale;
  view.scale = newScale;
  updateZoomLabel();
  saveState();
  draw();
}

function updateZoomLabel() {
  var el = document.getElementById('zoom-level');
  if (el) el.textContent = Math.round(view.scale * 100) + '%';
}

function contentBounds(padding) {
  var b = new BoundsRenderer();
  drawDiagram(b, {});
  return b.result(padding == null ? 24 : padding);
}

function resetView() {
  view.scale = 1;
  view.x = -cssWidth / 2;
  view.y = -cssHeight / 2;
  updateZoomLabel();
  saveState();
  draw();
}

function fitToContent() {
  if (!nodes.length) { resetView(); return; }
  var b = contentBounds(40);
  var scale = Math.min(cssWidth / b.width, cssHeight / b.height, 2);
  view.scale = Math.max(0.2, Math.min(4, scale));
  view.x = b.x + b.width / 2 - cssWidth / (2 * view.scale);
  view.y = b.y + b.height / 2 - cssHeight / (2 * view.scale);
  updateZoomLabel();
  saveState();
  draw();
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/*
 * The document: the whole diagram as plain data. Saving, and the optional
 * bridge to a local tool, both want exactly this, so it is built in one place.
 */
function serializeDoc(includeView) {
  var data = { nodes: [], links: [] };
  if (includeView) data.view = view;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    data.nodes.push({ x: n.x, y: n.y, text: n.text, isAcceptState: n.isAcceptState });
  }
  for (var j = 0; j < links.length; j++) {
    var l = links[j];
    if (l instanceof Link) {
      data.links.push({
        type: 'Link', nodeA: nodes.indexOf(l.nodeA), nodeB: nodes.indexOf(l.nodeB),
        text: l.text, parallelPart: l.parallelPart, perpendicularPart: l.perpendicularPart
      });
    } else if (l instanceof SelfLink) {
      data.links.push({
        type: 'SelfLink', node: nodes.indexOf(l.node),
        text: l.text, anchorAngle: l.anchorAngle
      });
    } else if (l instanceof StartLink) {
      data.links.push({
        type: 'StartLink', node: nodes.indexOf(l.node),
        text: l.text, deltaX: l.deltaX, deltaY: l.deltaY
      });
    }
  }
  return data;
}

function saveState() {
  try {
    if (window.localStorage) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeDoc(true)));
    }
  } catch (e) { /* storage unavailable or full: not fatal */ }
  // Every edit funnels through here, which makes it the one place a bridge
  // needs to listen for the diagram having changed.
  if (window.fsmDesigner && typeof window.fsmDesigner.onChange === 'function') {
    try { window.fsmDesigner.onChange(); } catch (e) { /* never break editing */ }
  }
}

// Replaces the whole diagram with `data`. Returns false if it is not a
// document, so a caller can tell "empty" from "not mine".
function loadDoc(data, keepView) {
  if (!data || !Array.isArray(data.nodes)) return false;
  nodes = [];
  links = [];
  focusObject(null);
  selection = [];
  currentLink = null;
  rubberBand = null;
  deserializeInto(data, keepView);
  draw();
  return true;
}

function deserializeInto(data, keepView) {
  var i;
  for (i = 0; i < data.nodes.length; i++) {
    var d = data.nodes[i];
    var node = new Node(d.x, d.y);
    node.text = d.text || '';
    node.isAcceptState = !!d.isAcceptState;
    node.updateSize();
    nodes.push(node);
  }
  for (i = 0; i < (data.links || []).length; i++) {
    var e = data.links[i], link = null;
    if (e.type === 'Link' && nodes[e.nodeA] && nodes[e.nodeB]) {
      link = new Link(nodes[e.nodeA], nodes[e.nodeB]);
      link.parallelPart = e.parallelPart;
      link.perpendicularPart = e.perpendicularPart;
    } else if (e.type === 'SelfLink' && nodes[e.node]) {
      link = new SelfLink(nodes[e.node]);
      link.anchorAngle = e.anchorAngle;
    } else if (e.type === 'StartLink' && nodes[e.node]) {
      link = new StartLink(nodes[e.node]);
      link.deltaX = e.deltaX;
      link.deltaY = e.deltaY;
    }
    if (link) { link.text = e.text || ''; links.push(link); }
  }
  if (!keepView && data.view && typeof data.view.scale === 'number') {
    view.x = data.view.x;
    view.y = data.view.y;
    view.scale = data.view.scale;
    updateZoomLabel();
  }
}

function restoreState() {
  if (!window.localStorage) return;
  var raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return; }
  if (!raw) return;
  var data;
  try { data = JSON.parse(raw); } catch (e) { return; }
  if (!data || !data.nodes) return;
  deserializeInto(data, false);
}

/*
 * The seam an outside tool works through. Everything else on this page stays
 * private; a bridge script only ever reads or replaces the whole document.
 */
window.fsmDesigner = {
  getDoc: function () { return serializeDoc(true); },
  setDoc: function (doc, keepView) {
    var ok = loadDoc(doc, keepView !== false);
    if (ok) { fitToContent(); saveState(); }
    return ok;
  },
  isEmpty: function () { return nodes.length === 0 && links.length === 0; },
  onChange: null    // assigned by the bridge client, called after every edit
};

/* ------------------------------------------------------------------ *
 * Exporters -- all share the ctx-like API used by drawDiagram
 * ------------------------------------------------------------------ */

function num(x) { return Math.round(x * 100) / 100; }

function escapeXml(s) {
  return s.replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
  });
}

// Turns a canvas-style arc into one or more SVG arc segments.
function arcSweep(a0, a1, ccw) {
  var delta;
  if (Math.abs(a1 - a0) >= TWO_PI - 1e-6) {
    delta = ccw ? -TWO_PI : TWO_PI;
  } else if (ccw) {
    delta = -mod2pi(a0 - a1);
  } else {
    delta = mod2pi(a1 - a0);
  }
  return delta;
}

function BoundsRenderer() {
  this.isExporter = true;
  this.minX = Infinity; this.minY = Infinity;
  this.maxX = -Infinity; this.maxY = -Infinity;
}
BoundsRenderer.prototype.add = function (x, y) {
  if (x < this.minX) this.minX = x;
  if (y < this.minY) this.minY = y;
  if (x > this.maxX) this.maxX = x;
  if (y > this.maxY) this.maxY = y;
};
BoundsRenderer.prototype.beginPath = function () {};
BoundsRenderer.prototype.closePath = function () {};
BoundsRenderer.prototype.moveTo = function (x, y) { this.add(x, y); };
BoundsRenderer.prototype.lineTo = function (x, y) { this.add(x, y); };
// Only the swept part of the arc counts, otherwise a gentle curve on a huge
// circle would pad the export with a screenful of empty space.
BoundsRenderer.prototype.arc = function (x, y, r, a0, a1, ccw) {
  var delta = arcSweep(a0, a1, ccw);
  var addAngle = function (self, ang) {
    self.add(x + r * Math.cos(ang), y + r * Math.sin(ang));
  };
  addAngle(this, a0);
  addAngle(this, a0 + delta);
  for (var k = 0; k < 4; k++) {
    var ang = k * Math.PI / 2;
    var swept = delta >= 0 ? mod2pi(ang - a0) <= delta
                           : mod2pi(a0 - ang) <= -delta;
    if (swept) addAngle(this, ang);
  }
};
BoundsRenderer.prototype.stroke = function () {};
BoundsRenderer.prototype.fill = function () {};
BoundsRenderer.prototype.drawSegments = function (segments, x, y, width) {
  this.add(x - width / 2, y - FONT_SIZE / 2);
  this.add(x + width / 2, y + FONT_SIZE / 2 + SUB_DROP);
};
BoundsRenderer.prototype.result = function (padding) {
  if (this.minX === Infinity) return { x: 0, y: 0, width: 100, height: 100 };
  return {
    x: this.minX - padding, y: this.minY - padding,
    width: (this.maxX - this.minX) + padding * 2,
    height: (this.maxY - this.minY) + padding * 2
  };
};

function SvgRenderer(bounds) {
  this.isExporter = true;
  this.bounds = bounds;
  this.parts = [];
  this.path = [];
  this.started = false;
  this.strokeStyle = '#000000';
  this.fillStyle = '#000000';
  this.lineWidth = 1;
}
SvgRenderer.prototype.beginPath = function () { this.path = []; this.started = false; };
SvgRenderer.prototype.closePath = function () { this.path.push('Z'); };
SvgRenderer.prototype.moveTo = function (x, y) {
  this.path.push('M ' + num(x) + ' ' + num(y));
  this.started = true;
};
SvgRenderer.prototype.lineTo = function (x, y) {
  this.path.push((this.started ? 'L ' : 'M ') + num(x) + ' ' + num(y));
  this.started = true;
};
SvgRenderer.prototype.arc = function (x, y, r, a0, a1, ccw) {
  var delta = arcSweep(a0, a1, ccw);
  var sx = x + r * Math.cos(a0), sy = y + r * Math.sin(a0);
  this.path.push((this.started ? 'L ' : 'M ') + num(sx) + ' ' + num(sy));
  this.started = true;
  var steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI * 0.99)));
  var sweep = delta > 0 ? 1 : 0;
  for (var i = 1; i <= steps; i++) {
    var ang = a0 + delta * i / steps;
    this.path.push('A ' + num(r) + ' ' + num(r) + ' 0 0 ' + sweep + ' ' +
      num(x + r * Math.cos(ang)) + ' ' + num(y + r * Math.sin(ang)));
  }
};
SvgRenderer.prototype.stroke = function () {
  this.parts.push('<path d="' + this.path.join(' ') + '" fill="none" stroke="' +
    this.strokeStyle + '" stroke-width="' + this.lineWidth + '"/>');
};
SvgRenderer.prototype.fill = function () {
  this.parts.push('<path d="' + this.path.join(' ') + '" fill="' +
    this.fillStyle + '" stroke="none"/>');
};
// Each run is its own <text> at a position already computed from the canvas
// metrics, which sidesteps tspan baseline-shift bookkeeping and keeps the SVG
// pixel-identical to what the canvas draws.
SvgRenderer.prototype.drawSegments = function (segments, x, y, width) {
  var cursor = x - width / 2;
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    var size = seg.sub ? SUB_FONT_SIZE : FONT_SIZE;
    this.parts.push('<text x="' + num(cursor) + '" y="' +
      num(y + (seg.sub ? SUB_DROP : 0)) +
      '" font-family="Times New Roman, serif" font-size="' + size +
      '" fill="' + this.fillStyle +
      '" text-anchor="start" dominant-baseline="central">' +
      escapeXml(seg.text) + '</text>');
    cursor += segmentWidth(seg);
  }
};
SvgRenderer.prototype.toSvg = function () {
  var b = this.bounds;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.ceil(b.width) +
    '" height="' + Math.ceil(b.height) + '" viewBox="' + num(b.x) + ' ' +
    num(b.y) + ' ' + num(b.width) + ' ' + num(b.height) + '">\n' +
    '<rect x="' + num(b.x) + '" y="' + num(b.y) + '" width="' + num(b.width) +
    '" height="' + num(b.height) + '" fill="#ffffff"/>\n' +
    this.parts.join('\n') + '\n</svg>\n';
};

// TikZ output. Canvas y grows downward, TikZ y grows upward, so every
// coordinate and angle is mirrored on the way out.
function TikzRenderer(bounds) {
  this.isExporter = true;
  this.scale = 40;
  this.originX = bounds.x + bounds.width / 2;
  this.originY = bounds.y + bounds.height / 2;
  this.parts = [];
  this.ops = [];
  this.strokeStyle = '#000000';
  this.fillStyle = '#000000';
}
TikzRenderer.prototype.px = function (x) { return num((x - this.originX) / this.scale); };
TikzRenderer.prototype.py = function (y) { return num(-(y - this.originY) / this.scale); };
TikzRenderer.prototype.pt = function (x, y) { return '(' + this.px(x) + ',' + this.py(y) + ')'; };
TikzRenderer.prototype.beginPath = function () { this.ops = []; };
TikzRenderer.prototype.closePath = function () { this.ops.push({ k: 'close' }); };
TikzRenderer.prototype.moveTo = function (x, y) { this.ops.push({ k: 'move', x: x, y: y }); };
TikzRenderer.prototype.lineTo = function (x, y) { this.ops.push({ k: 'line', x: x, y: y }); };
TikzRenderer.prototype.arc = function (x, y, r, a0, a1, ccw) {
  this.ops.push({ k: 'arc', x: x, y: y, r: r, a0: a0, delta: arcSweep(a0, a1, ccw) });
};
TikzRenderer.prototype.emit = function (cmd) {
  var out = [], self = this;
  for (var i = 0; i < this.ops.length; i++) {
    var op = this.ops[i];
    if (op.k === 'move') {
      out.push(self.pt(op.x, op.y));
    } else if (op.k === 'line') {
      if (!out.length) out.push(self.pt(op.x, op.y));
      else out.push('-- ' + self.pt(op.x, op.y));
    } else if (op.k === 'arc') {
      var sx = op.x + op.r * Math.cos(op.a0), sy = op.y + op.r * Math.sin(op.a0);
      if (!out.length) out.push(self.pt(sx, sy));
      else out.push('-- ' + self.pt(sx, sy));
      var deg = function (a) { return num(-a * 180 / Math.PI); };
      out.push('arc (' + deg(op.a0) + ':' + deg(op.a0 + op.delta) + ':' +
        num(op.r / self.scale) + ')');
    } else if (op.k === 'close') {
      out.push('-- cycle');
    }
  }
  if (out.length) this.parts.push('\t' + cmd + ' ' + out.join(' ') + ';');
};
TikzRenderer.prototype.stroke = function () { this.emit('\\draw[thick]'); };
TikzRenderer.prototype.fill = function () { this.emit('\\fill'); };
// TikZ has real subscripts, so the label goes out as one node with $_{...}$
// rather than as separately positioned runs.
TikzRenderer.prototype.drawSegments = function (segments, x, y) {
  var out = '';
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    out += seg.sub ? '$_{\\mathrm{' + textToLatex(seg.text, true) + '}}$'
                   : textToLatex(seg.text, false);
  }
  if (out) this.parts.push('\t\\node at ' + this.pt(x, y) + ' {' + out + '};');
};
/*
 * No `scale=` option on the tikzpicture: TikZ's scale transforms coordinates
 * and arc radii but deliberately leaves node text alone, so any scale other
 * than 1 shrinks the states out from under their labels. Proportions are set
 * instead by `this.scale` px-per-cm, chosen so the 20px canvas font lands near
 * the 12pt body font.
 */
TikzRenderer.prototype.toLatex = function () {
  return '\\documentclass[12pt]{article}\n' +
    '\\usepackage{tikz}\n' +
    '\\usepackage{graphicx}\n\n' +
    '\\begin{document}\n\n' +
    '\\begin{center}\n' +
    '% Shrink to the text width only if the diagram is wider than the page.\n' +
    '% \\resizebox scales the labels along with the shapes, so proportions hold.\n' +
    '\\resizebox{\\ifdim\\width>\\linewidth\\linewidth\\else\\width\\fi}{!}{%\n' +
    '\\begin{tikzpicture}\n' +
    '\\tikzset{every node/.append style={inner sep=0pt}}\n' +
    this.parts.join('\n') + '\n' +
    '\\end{tikzpicture}%\n' +
    '}\n' +
    '\\end{center}\n\n' +
    '\\end{document}\n';
};

function downloadBlob(filename, mime, text) {
  var blob = new Blob([text], { type: mime });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function exportPng() {
  var b = contentBounds(24);
  var ratio = 2;
  var out = document.createElement('canvas');
  out.width = Math.ceil(b.width * ratio);
  out.height = Math.ceil(b.height * ratio);
  var c = out.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, out.width, out.height);
  c.scale(ratio, ratio);
  c.translate(-b.x, -b.y);
  c.lineJoin = 'round';
  drawDiagram(c, {});
  out.toBlob(function (blob) {
    if (!blob) return;
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'fsm.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }, 'image/png');
}

function exportSvg() {
  var b = contentBounds(24);
  var r = new SvgRenderer(b);
  drawDiagram(r, {});
  downloadBlob('fsm.svg', 'image/svg+xml', r.toSvg());
}

function exportLatex() {
  var b = contentBounds(24);
  var r = new TikzRenderer(b);
  drawDiagram(r, {});
  showModal('LaTeX (TikZ)', r.toLatex());
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

function showModal(title, text) {
  document.getElementById('modal-title').textContent = title;
  var area = document.getElementById('modal-text');
  area.value = text;
  document.getElementById('modal').classList.remove('hidden');
  area.focus();
  area.select();
}

function hideModal() {
  document.getElementById('modal').classList.add('hidden');
}

/* ------------------------------------------------------------------ *
 * Input handling
 * ------------------------------------------------------------------ */

function modalOpen() {
  return !document.getElementById('modal').classList.contains('hidden');
}

function onMouseDown(e) {
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    startPan(e);
    e.preventDefault();
    return;
  }
  if (e.button === 2) {
    var start = toWorld(e);
    rubberBand = { x0: start.x, y0: start.y, x1: start.x, y1: start.y,
                   add: e.shiftKey };
    if (!e.shiftKey) { selection = []; focusObject(null); }
    draw();
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;

  var p = toWorld(e);
  originalClick = p;

  /*
   * A click on a label puts the caret where it was clicked.
   *
   * An arrow's label sits clear of its line, so dragging out of one can only
   * mean "highlight this text" -- there is nothing else there to grab. A
   * state's label sits inside the state, where a drag still has to mean "move
   * me", so a click there places the caret and then falls through to the
   * normal move handling; highlighting a state's label is done from the
   * keyboard with shift-arrows or Ctrl+A.
   *
   * Shift is left alone throughout: it already means "draw an arrow".
   */
  var label = shiftPressed ? null : labelAt(p.x, p.y);
  var labelledLink = label && !(label.object instanceof Node);

  if (labelledLink) {
    if (label.object !== selectedObject) focusObject(label.object);
    selection = [];
    movingObject = false;
    currentLink = null;
    moveCaret(caretIndexAtX(label.place, p.x), false);
    textDragging = true;
    e.preventDefault();
    return;
  }

  var target = objectAt(p.x, p.y);
  var clickedOwnLabel = label && label.object === target;
  if (target !== selectedObject) focusObject(target);
  if (clickedOwnLabel) moveCaret(caretIndexAtX(label.place, p.x), false);
  movingObject = false;
  currentLink = null;

  if (selectedObject) {
    if (shiftPressed && selectedObject instanceof Node) {
      currentLink = new SelfLink(selectedObject, p);
    } else {
      movingObject = true;
      // Grabbing a state outside the current group replaces it; grabbing one
      // inside keeps the group so the whole thing moves together.
      if (selectedObject instanceof Node) {
        if (selection.indexOf(selectedObject) < 0) selection = [selectedObject];
        for (var i = 0; i < selection.length; i++) {
          selection[i].setMouseStart(p.x, p.y);
        }
      } else {
        selection = [];
        if (selectedObject.setMouseStart) selectedObject.setMouseStart(p.x, p.y);
      }
    }
  } else if (shiftPressed) {
    selection = [];
    currentLink = new TemporaryLink(p, p);
  } else {
    selection = [];
    startPan(e);
  }

  resetCaret();
  draw();
  e.preventDefault();
}

function startPan(e) {
  panning = true;
  panStart = { x: e.clientX, y: e.clientY, viewX: view.x, viewY: view.y };
  canvas.style.cursor = 'grabbing';
}

function onMouseMove(e) {
  if (textDragging && selectedObject) {
    var place = selectedObject.labelPlace();
    if (place) {
      if (selectAnchor == null) selectAnchor = caretIndex;
      caretIndex = caretIndexAtX(place, toWorld(e).x);
      caretVisible = true;
      draw();
    }
    return;
  }
  if (rubberBand) {
    var r = toWorld(e);
    rubberBand.x1 = r.x;
    rubberBand.y1 = r.y;
    draw();
    return;
  }
  if (panning) {
    view.x = panStart.viewX - (e.clientX - panStart.x) / view.scale;
    view.y = panStart.viewY - (e.clientY - panStart.y) / view.scale;
    draw();
    return;
  }

  var p = toWorld(e);

  if (currentLink) {
    var target = nodeAt(p.x, p.y);
    if (selectedObject instanceof Node) {
      if (target === selectedObject) {
        currentLink = new SelfLink(selectedObject, p);
      } else if (target) {
        currentLink = new Link(selectedObject, target);
      } else {
        currentLink = new TemporaryLink(
          selectedObject.boundaryToward(p.x, p.y), p);
      }
    } else {
      if (target) {
        currentLink = new StartLink(target, originalClick);
      } else {
        currentLink = new TemporaryLink(originalClick, p);
      }
    }
    draw();
    return;
  }

  if (movingObject && selectedObject) {
    if (selectedObject instanceof Node && selection.length) {
      for (var i = 0; i < selection.length; i++) {
        selection[i].setAnchorPoint(p.x, p.y);
      }
      // Alignment snapping only makes sense for a lone state; across a group
      // it would drag members out of formation.
      if (selection.length === 1) snapNode(selection[0]);
    } else {
      selectedObject.setAnchorPoint(p.x, p.y);
    }
    draw();
    return;
  }

  canvas.style.cursor = objectAt(p.x, p.y) ? 'move' : 'grab';
}

function onMouseUp(e) {
  if (textDragging) {
    textDragging = false;
    resetCaret();
    draw();
    return;
  }
  if (rubberBand) {
    applyRubberBand();
    rubberBand = null;
    resetCaret();
    draw();
    return;
  }
  if (panning) {
    panning = false;
    canvas.style.cursor = 'grab';
    saveState();
    return;
  }
  if (movingObject) {
    movingObject = false;
    saveState();
  }
  if (currentLink) {
    if (!(currentLink instanceof TemporaryLink)) {
      focusObject(currentLink);
      links.push(currentLink);
      resetCaret();
      saveState();
    }
    currentLink = null;
    draw();
  }
}

function onDoubleClick(e) {
  var p = toWorld(e);
  var target = objectAt(p.x, p.y);
  if (target instanceof Node) {
    target.isAcceptState = !target.isAcceptState;
    focusObject(target);
  } else if (!target) {
    var node = new Node(p.x, p.y);
    node.updateSize();
    nodes.push(node);
    focusObject(node);
  }
  resetCaret();
  saveState();
  draw();
  e.preventDefault();
}

function onWheel(e) {
  e.preventDefault();
  var factor = Math.pow(1.0015, -e.deltaY);
  setScale(view.scale * factor, e.clientX, e.clientY);
}

function setSelectedText(text) {
  selectedObject.text = text;
  if (selectedObject instanceof Node) selectedObject.updateSize();
  var count = scanUnits(text).length;
  caretIndex = Math.max(0, Math.min(count, caretIndex));
  if (selectAnchor != null) {
    selectAnchor = Math.max(0, Math.min(count, selectAnchor));
  }
  resetCaret();
  saveState();
  draw();
}

function onKeyDown(e) {
  if (modalOpen()) {
    if (e.key === 'Escape') hideModal();
    return;
  }
  if (e.key === 'Shift') shiftPressed = true;

  var typingElsewhere = /^(INPUT|TEXTAREA)$/.test((e.target || {}).tagName || '');
  if (typingElsewhere) return;

  var editingLabel = textEditing && selectedObject;

  if (e.key === 'ArrowLeft' && selectedObject) {
    moveCaret(caretIndex - 1, e.shiftKey);
    e.preventDefault();
  } else if (e.key === 'ArrowRight' && selectedObject) {
    moveCaret(caretIndex + 1, e.shiftKey);
    e.preventDefault();
  } else if (e.key === 'Home' && selectedObject) {
    moveCaret(0, e.shiftKey);
    e.preventDefault();
  } else if (e.key === 'End' && selectedObject) {
    moveCaret(editUnits().length, e.shiftKey);
    e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') &&
             selectedObject && selectedObject.text) {
    selectAllText();
    e.preventDefault();
  } else if (e.key === 'Backspace') {
    if (editingLabel) backspaceAtCaret();
    else if (selectedObject) setSelectedText(selectedObject.text.slice(0, -1));
    e.preventDefault();
  } else if (e.key === 'Delete') {
    // Inside a label, Delete removes highlighted text or the next glyph;
    // it only falls through to removing the object when there is neither.
    if (!(editingLabel && forwardDeleteAtCaret())) deleteSelected();
    e.preventDefault();
  } else if (e.key === 'Escape') {
    focusObject(null);
    selection = [];
    draw();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
    setScale(view.scale * 1.2);
    e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
    setScale(view.scale / 1.2);
    e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
    resetView();
    e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    /*
     * Highlighted label text wins; otherwise this copies the selected states.
     * The text is banked here rather than waiting on the copy event, which
     * only mirrors it onto the system clipboard and does not always fire.
     */
    if (hasTextRange()) {
      textClipboard = selectedText();
      lastCopyKind = 'text';
    } else {
      copySelection();
      e.preventDefault();
    }
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
    if (hasTextRange()) {
      textClipboard = selectedText();
      lastCopyKind = 'text';
      // The cut event removes the text if it fires; this catches the case
      // where it does not, so Ctrl+X is never a copy that forgot to cut.
      pendingCut = true;
      setTimeout(function () {
        if (!pendingCut) return;
        pendingCut = false;
        if (hasTextRange()) deleteTextRange();
      }, 0);
    } else {
      cutSelection();
      e.preventDefault();
    }
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
    if (wantsTextPaste()) {
      // Prefer the paste event, which carries whatever is really on the
      // system clipboard; fall back to our own copy when it never arrives.
      pendingTextPaste = true;
      setTimeout(function () {
        if (!pendingTextPaste) return;
        pendingTextPaste = false;
        insertTextPaste(textClipboard);
      }, 0);
    } else {
      pasteClipboard();
      e.preventDefault();
    }
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey &&
             e.key && e.key.length === 1 && selectedObject) {
    if (textEditing) insertAtCaret(e.key);
    else setSelectedText(selectedObject.text + e.key);
    e.preventDefault();
  }
}

/*
 * Clipboard events rather than the keydown, so label text goes to and from
 * the real system clipboard without asking for clipboard permissions.
 */
function onCopyEvent(e) {
  if (modalOpen() || !hasTextRange()) return;
  var text = selectedText();
  textClipboard = text;
  lastCopyKind = 'text';
  if (e.clipboardData) {
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  }
}

function onCutEvent(e) {
  if (modalOpen() || !hasTextRange()) return;
  onCopyEvent(e);
  pendingCut = false;
  deleteTextRange();
}

function onPasteEvent(e) {
  if (modalOpen() || !wantsTextPaste()) return;
  pendingTextPaste = false;
  var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  if (!text) text = textClipboard;
  if (!text) return;
  e.preventDefault();
  insertTextPaste(text);
}

/* ------------------------------------------------------------------ *
 * Editing a label's text
 * ------------------------------------------------------------------ */

// Makes `obj` the edit target, with the caret parked at the end and nothing
// highlighted. Called wherever the selection changes for a reason other than
// clicking into a label.
function focusObject(obj) {
  selectedObject = obj;
  selectAnchor = null;
  textEditing = false;
  textDragging = false;
  caretIndex = obj ? scanUnits(obj.text).length : 0;
}

function editUnits() {
  return selectedObject ? scanUnits(selectedObject.text) : [];
}

function hasTextRange() {
  return textEditing && selectAnchor != null && selectAnchor !== caretIndex;
}

function textRange() {
  return {
    from: Math.min(selectAnchor, caretIndex),
    to: Math.max(selectAnchor, caretIndex)
  };
}

function selectedText() {
  if (!hasTextRange()) return '';
  var r = textRange();
  return unitsToRaw(editUnits(), r.from, r.to);
}

function moveCaret(to, extend) {
  var units = editUnits();
  to = Math.max(0, Math.min(units.length, to));
  if (extend) {
    if (selectAnchor == null) selectAnchor = caretIndex;
  } else {
    selectAnchor = null;
  }
  caretIndex = to;
  textEditing = true;
  resetCaret();
  draw();
}

function selectAllText() {
  var units = editUnits();
  if (!units.length) return;
  selectAnchor = 0;
  caretIndex = units.length;
  textEditing = true;
  resetCaret();
  draw();
}

function deleteTextRange() {
  var r = textRange();
  var raw = rawWithout(editUnits(), r.from, r.to);
  caretIndex = r.from;
  selectAnchor = null;
  setSelectedText(raw);
}

/*
 * Typed and pasted text is spliced into the raw string at the glyph's own
 * insertion point, so a character typed inside q_{start} stays inside the
 * braces and stays subscript.
 */
function insertAtCaret(str) {
  if (!selectedObject || !str) return;
  if (hasTextRange()) deleteTextRange();

  var raw = selectedObject.text;
  var units = scanUnits(raw);
  var at = caretIndex < units.length ? units[caretIndex].insertAt : raw.length;
  var next = raw.slice(0, at) + str + raw.slice(at);

  caretIndex += scanUnits(next).length - units.length;
  selectAnchor = null;
  textEditing = true;
  setSelectedText(next);
}

function backspaceAtCaret() {
  if (!selectedObject) return;
  if (hasTextRange()) { deleteTextRange(); return; }
  if (caretIndex <= 0) return;
  var raw = rawWithout(editUnits(), caretIndex - 1, caretIndex);
  caretIndex--;
  selectAnchor = null;
  setSelectedText(raw);
}

function forwardDeleteAtCaret() {
  if (!selectedObject) return false;
  if (hasTextRange()) { deleteTextRange(); return true; }
  var units = editUnits();
  if (caretIndex >= units.length) return false;
  setSelectedText(rawWithout(units, caretIndex, caretIndex + 1));
  return true;
}

/* ------------------------------------------------------------------ *
 * Copy and paste
 * ------------------------------------------------------------------ */

var clipboard = null;    // plain data, not live objects
var pasteCount = 0;      // so repeated pastes cascade instead of stacking
var PASTE_OFFSET = 32;

/*
 * There are two clipboards -- states and label text -- and one Ctrl+V, so
 * something has to decide which one a paste means. Whichever was copied last
 * wins: having just copied a label, pasting into a label is what you meant.
 */
var lastCopyKind = null;   // 'nodes' | 'text'
var pendingTextPaste = false;
var pendingCut = false;

function wantsTextPaste() {
  return !!(selectedObject && lastCopyKind === 'text' && textClipboard);
}

// Pasting into an object selected by its line, rather than by clicking its
// text, drops the text in at the caret's resting place: the end of the label.
function insertTextPaste(text) {
  if (!selectedObject) return;
  textEditing = true;
  insertAtCaret(text.replace(/[\r\n\t]+/g, ' '));
}

// Falls back to the single edit target so Ctrl+C works after a plain click.
function selectedNodes() {
  if (selection.length) return selection;
  return selectedObject instanceof Node ? [selectedObject] : [];
}

/*
 * A link is only worth copying when both of its ends come along; a transition
 * to a state that was left behind has nowhere to land in the pasted copy.
 */
function copySelection() {
  var picked = selectedNodes();
  if (!picked.length) return false;

  var data = { nodes: [], links: [] };
  for (var i = 0; i < picked.length; i++) {
    data.nodes.push({
      x: picked[i].x, y: picked[i].y,
      text: picked[i].text, isAcceptState: picked[i].isAcceptState
    });
  }
  for (var j = 0; j < links.length; j++) {
    var l = links[j];
    var a = picked.indexOf(l.nodeA), b = picked.indexOf(l.nodeB);
    var n = picked.indexOf(l.node);
    if (l instanceof Link && a >= 0 && b >= 0) {
      data.links.push({ type: 'Link', nodeA: a, nodeB: b, text: l.text,
        parallelPart: l.parallelPart, perpendicularPart: l.perpendicularPart });
    } else if (l instanceof SelfLink && n >= 0) {
      data.links.push({ type: 'SelfLink', node: n, text: l.text,
        anchorAngle: l.anchorAngle });
    } else if (l instanceof StartLink && n >= 0) {
      data.links.push({ type: 'StartLink', node: n, text: l.text,
        deltaX: l.deltaX, deltaY: l.deltaY });
    }
  }
  clipboard = data;
  pasteCount = 0;
  lastCopyKind = 'nodes';
  return true;
}

function pasteClipboard() {
  if (!clipboard || !clipboard.nodes.length) return;
  pasteCount++;
  var shift = PASTE_OFFSET * pasteCount;
  var created = [], i;

  for (i = 0; i < clipboard.nodes.length; i++) {
    var d = clipboard.nodes[i];
    var node = new Node(d.x + shift, d.y + shift);
    node.text = d.text;
    node.isAcceptState = d.isAcceptState;
    node.updateSize();
    nodes.push(node);
    created.push(node);
  }
  for (i = 0; i < clipboard.links.length; i++) {
    var e = clipboard.links[i], link = null;
    if (e.type === 'Link') {
      link = new Link(created[e.nodeA], created[e.nodeB]);
      link.parallelPart = e.parallelPart;
      link.perpendicularPart = e.perpendicularPart;
    } else if (e.type === 'SelfLink') {
      link = new SelfLink(created[e.node]);
      link.anchorAngle = e.anchorAngle;
    } else if (e.type === 'StartLink') {
      link = new StartLink(created[e.node]);
      link.deltaX = e.deltaX;
      link.deltaY = e.deltaY;
    }
    if (link) { link.text = e.text; links.push(link); }
  }

  selection = created;
  focusObject(created.length === 1 ? created[0] : null);
  resetCaret();
  saveState();
  draw();
}

function cutSelection() {
  if (copySelection()) deleteSelected();
}

function deleteSelected() {
  var doomed = selection.slice();
  if (selectedObject && doomed.indexOf(selectedObject) < 0) {
    doomed.push(selectedObject);
  }
  if (!doomed.length) return;

  var gone = function (o) { return o && doomed.indexOf(o) >= 0; };
  var i;
  for (i = nodes.length - 1; i >= 0; i--) {
    if (gone(nodes[i])) nodes.splice(i, 1);
  }
  for (i = links.length - 1; i >= 0; i--) {
    var l = links[i];
    if (gone(l) || gone(l.node) || gone(l.nodeA) || gone(l.nodeB)) {
      links.splice(i, 1);
    }
  }
  focusObject(null);
  selection = [];
  saveState();
  draw();
}

function onKeyUp(e) {
  if (e.key === 'Shift') shiftPressed = false;
}

function resetCaret() {
  caretVisible = true;
  clearInterval(resetCaret.timer);
  resetCaret.timer = setInterval(function () {
    if (!selectedObject) return;
    caretVisible = !caretVisible;
    draw();
  }, 500);
}

function clearAll() {
  if (nodes.length || links.length) {
    if (!window.confirm('Clear the whole canvas? This cannot be undone.')) return;
  }
  nodes = [];
  links = [];
  focusObject(null);
  selection = [];
  rubberBand = null;
  currentLink = null;
  saveState();
  draw();
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

function resizeCanvas() {
  var rect = canvas.getBoundingClientRect();
  var dpr = window.devicePixelRatio || 1;
  cssWidth = rect.width;
  cssHeight = rect.height;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  draw();
}

function init() {
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');

  restoreState();

  canvas.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('copy', onCopyEvent);
  document.addEventListener('cut', onCutEvent);
  document.addEventListener('paste', onPasteEvent);

  document.getElementById('clear-all').addEventListener('click', clearAll);
  document.getElementById('export-png').addEventListener('click', exportPng);
  document.getElementById('export-svg').addEventListener('click', exportSvg);
  document.getElementById('export-latex').addEventListener('click', exportLatex);

  document.getElementById('zoom-in').addEventListener('click', function () {
    setScale(view.scale * 1.25);
  });
  document.getElementById('zoom-out').addEventListener('click', function () {
    setScale(view.scale / 1.25);
  });
  document.getElementById('zoom-reset').addEventListener('click', resetView);
  document.getElementById('zoom-fit').addEventListener('click', fitToContent);

  document.getElementById('modal-close').addEventListener('click', hideModal);
  document.getElementById('modal-copy').addEventListener('click', function () {
    var area = document.getElementById('modal-text');
    area.select();
    if (navigator.clipboard) navigator.clipboard.writeText(area.value);
    else document.execCommand('copy');
  });
  document.getElementById('modal-download').addEventListener('click', function () {
    downloadBlob('fsm.tex', 'text/plain', document.getElementById('modal-text').value);
  });
  document.getElementById('modal').addEventListener('mousedown', function (e) {
    if (e.target.id === 'modal') hideModal();
  });

  window.addEventListener('resize', resizeCanvas);
  updateZoomLabel();
  resizeCanvas();
  canvas.style.cursor = 'grab';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
