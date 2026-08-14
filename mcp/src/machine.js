'use strict';

/*
 * The machine model, and the translation between the two shapes a machine
 * takes here.
 *
 *   "document"  what the designer saves: nodes with coordinates, links with
 *               curve handles. Everything needed to draw it, nothing that
 *               says what it means.
 *   "machine"   what the analysis works on: states, a start state, accepting
 *               states, and transitions carrying symbols.
 *
 * Keeping both, and converting between them, is what lets Claude reason about
 * a construction the user drew and hand back something they can still edit.
 */

const GREEK = {
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
  Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ',
  Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ',
  Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω'
};
const GREEK_NAMES = Object.keys(GREEK).sort((a, b) => b.length - a.length);
const SUB_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

// Raw label source -> the glyphs the designer actually draws. Used wherever a
// machine is described back to a human, so the names match what is on screen.
function renderLabel(raw) {
  let out = '';
  for (let i = 0; i < (raw || '').length; i++) {
    if (raw[i] === '\\') {
      const name = GREEK_NAMES.find(n => raw.substr(i + 1, n.length) === n);
      if (name) { out += GREEK[name]; i += name.length; continue; }
    }
    if (raw[i] === '_' && i + 1 < raw.length) {
      let body, skip;
      if (raw[i + 1] === '{') {
        const end = raw.indexOf('}', i + 2);
        if (end >= 0) { body = raw.slice(i + 2, end); skip = end - i; }
      } else { body = raw[i + 1]; skip = 1; }
      if (body != null) {
        // Digits have real subscript glyphs; letters do not, so they keep the
        // underscore rather than silently losing the distinction.
        if (/^\d+$/.test(body)) {
          out += [...body].map(d => SUB_DIGITS[+d]).join('');
        } else {
          out += '_' + (body.length > 1 ? `{${body}}` : body);
        }
        i += skip;
        continue;
      }
    }
    out += raw[i];
  }
  return out;
}

const EPSILON_WORDS = new Set(['ε', 'λ', 'e', 'eps', 'epsilon', 'lambda', '']);

function isEpsilonToken(token) {
  const t = renderLabel(token).trim();
  return EPSILON_WORDS.has(t) || EPSILON_WORDS.has(t.toLowerCase());
}

/*
 * An arrow's label is a comma-separated set of symbols, the convention the
 * designer's own help text teaches ("0,1"). An empty label is left as no
 * symbols at all rather than being guessed at -- analyze() reports it.
 */
function parseSymbols(raw) {
  const text = (raw || '').trim();
  if (text === '') return { symbols: [], epsilon: false, unlabelled: true };

  const symbols = [];
  let epsilon = false;
  for (const piece of text.split(',')) {
    const token = piece.trim();
    if (token === '') continue;
    if (isEpsilonToken(token)) { epsilon = true; continue; }
    const sym = renderLabel(token);
    if (!symbols.includes(sym)) symbols.push(sym);
  }
  return { symbols, epsilon, unlabelled: false };
}

function symbolsToLabel(symbols, epsilon) {
  const parts = symbols.slice();
  if (epsilon) parts.push('ε');
  return parts.join(',');
}

/* ------------------------------------------------------------------ *
 * document -> machine
 * ------------------------------------------------------------------ */

function docToMachine(doc, name) {
  const nodes = (doc && doc.nodes) || [];
  const links = (doc && doc.links) || [];

  const states = nodes.map((n, i) => ({
    id: `s${i}`,
    label: (n.text || '').trim(),
    name: renderLabel((n.text || '').trim()) || `s${i}`,
    accepting: !!n.isAcceptState,
    start: false,
    x: typeof n.x === 'number' ? n.x : 0,
    y: typeof n.y === 'number' ? n.y : 0
  }));

  const transitions = [];
  const startMarks = [];

  links.forEach((l, i) => {
    const sym = parseSymbols(l.text);
    if (l.type === 'StartLink') {
      if (states[l.node]) startMarks.push(l.node);
      return;
    }
    const from = l.type === 'SelfLink' ? l.node : l.nodeA;
    const to = l.type === 'SelfLink' ? l.node : l.nodeB;
    if (!states[from] || !states[to]) return;
    transitions.push({
      id: `t${i}`,
      from: states[from].id,
      to: states[to].id,
      symbols: sym.symbols,
      epsilon: sym.epsilon,
      unlabelled: sym.unlabelled,
      label: (l.text || '').trim()
    });
  });

  for (const idx of startMarks) states[idx].start = true;

  return normalize({
    name: name || (doc && doc.name) || 'machine',
    states,
    transitions,
    startMarks: startMarks.length,
    // No start arrow on the canvas means no start state, whatever normalize
    // has to assume in order to run the thing.
    startInferred: startMarks.length === 0
  });
}

/* ------------------------------------------------------------------ *
 * machine -> document
 * ------------------------------------------------------------------ */

function machineToDoc(machine, options = {}) {
  const m = normalize(machine);
  const index = new Map(m.states.map((s, i) => [s.id, i]));

  const nodes = m.states.map(s => ({
    x: Math.round(s.x || 0),
    y: Math.round(s.y || 0),
    text: s.label != null ? s.label : s.name,
    isAcceptState: !!s.accepting
  }));

  const links = [];
  for (const t of m.transitions) {
    const a = index.get(t.from);
    const b = index.get(t.to);
    if (a == null || b == null) continue;
    const text = t.label != null && t.label !== ''
      ? t.label : symbolsToLabel(t.symbols, t.epsilon);
    if (a === b) {
      links.push({ type: 'SelfLink', node: a, text, anchorAngle: t.anchorAngle != null ? t.anchorAngle : -Math.PI / 2 });
    } else {
      links.push({
        type: 'Link', nodeA: a, nodeB: b, text,
        parallelPart: t.parallelPart != null ? t.parallelPart : 0.5,
        perpendicularPart: t.perpendicularPart != null ? t.perpendicularPart : 0
      });
    }
  }

  const start = m.states.find(s => s.start);
  if (start) {
    links.push({
      type: 'StartLink', node: index.get(start.id), text: '',
      deltaX: options.startDeltaX != null ? options.startDeltaX : -90,
      deltaY: options.startDeltaY != null ? options.startDeltaY : 0
    });
  }

  return { nodes, links };
}

/* ------------------------------------------------------------------ *
 * Normalising and building
 * ------------------------------------------------------------------ */

/*
 * Accepts the loose shapes a caller might reasonably send -- states as bare
 * strings, transitions written `on` or `symbols` or `label`, a separate
 * `start`/`accepting` list -- and returns the one canonical shape everything
 * downstream relies on.
 */
function normalize(input) {
  const raw = input || {};
  const states = [];
  const byKey = new Map();

  const addState = (spec, i) => {
    const s = typeof spec === 'string' ? { name: spec } : (spec || {});
    const name = String(s.name != null ? s.name : (s.label != null ? s.label : `q${i}`));
    const id = String(s.id != null ? s.id : name);
    const state = {
      id,
      label: s.label != null ? s.label : name,
      name,
      accepting: !!(s.accepting || s.isAcceptState || s.final),
      start: !!s.start,
      x: typeof s.x === 'number' ? s.x : null,
      y: typeof s.y === 'number' ? s.y : null
    };
    states.push(state);
    byKey.set(id, state);
    if (!byKey.has(name)) byKey.set(name, state);
    return state;
  };

  (raw.states || []).forEach(addState);

  for (const name of raw.accepting || []) {
    const s = byKey.get(String(name));
    if (s) s.accepting = true;
  }
  if (raw.start != null) {
    const s = byKey.get(String(raw.start));
    if (s) s.start = true;
  }

  const transitions = [];
  (raw.transitions || []).forEach((t, i) => {
    if (!t) return;
    const from = byKey.get(String(t.from));
    const to = byKey.get(String(t.to));
    if (!from || !to) return;

    let symbols = [];
    let epsilon = !!t.epsilon;
    let unlabelled = !!t.unlabelled;

    if (Array.isArray(t.symbols)) symbols = t.symbols.map(String);
    else if (Array.isArray(t.on)) symbols = t.on.map(String);
    else if (t.on != null) symbols = [String(t.on)];
    else if (t.symbol != null) symbols = [String(t.symbol)];
    else if (t.label != null) {
      const parsed = parseSymbols(t.label);
      symbols = parsed.symbols;
      epsilon = epsilon || parsed.epsilon;
      unlabelled = parsed.unlabelled;
    }

    // A caller writing `on: "ε"` means the empty move, not a symbol named eps.
    symbols = symbols.filter(sym => {
      if (isEpsilonToken(sym) && sym !== '') { epsilon = true; return false; }
      return true;
    });

    transitions.push({
      id: t.id != null ? String(t.id) : `t${i}`,
      from: from.id, to: to.id, symbols, epsilon, unlabelled,
      label: t.label != null ? t.label : symbolsToLabel(symbols, epsilon),
      parallelPart: t.parallelPart,
      perpendicularPart: t.perpendicularPart,
      anchorAngle: t.anchorAngle,
      labelOffset: t.labelOffset
    });
  });

  /*
   * A machine with no start state cannot be run at all, so one is assumed --
   * but the fact that it was assumed is carried along. Forgetting the start
   * arrow is a common slip when drawing, and quietly inventing one would hide
   * exactly the mistake the user needs pointing out.
   */
  let startInferred = !!raw.startInferred;
  if (!states.some(s => s.start) && states.length) {
    states[0].start = true;
    startInferred = true;
  }

  return {
    name: raw.name || 'machine',
    states,
    transitions,
    startMarks: raw.startMarks,
    startInferred
  };
}

function alphabetOf(machine) {
  const set = new Set();
  for (const t of machine.transitions) for (const s of t.symbols) set.add(s);
  return [...set].sort();
}

function stateById(machine, id) {
  return machine.states.find(s => s.id === id) || null;
}

function displayName(machine, id) {
  const s = stateById(machine, id);
  return s ? (s.name || s.id) : id;
}

// from -> symbol -> [to], plus the epsilon moves, which every algorithm here
// wants in this shape.
function transitionIndex(machine) {
  const move = new Map();
  const eps = new Map();
  for (const s of machine.states) { move.set(s.id, new Map()); eps.set(s.id, []); }

  for (const t of machine.transitions) {
    if (!move.has(t.from)) continue;
    if (t.epsilon && !eps.get(t.from).includes(t.to)) eps.get(t.from).push(t.to);
    for (const sym of t.symbols) {
      const row = move.get(t.from);
      if (!row.has(sym)) row.set(sym, []);
      if (!row.get(sym).includes(t.to)) row.get(sym).push(t.to);
    }
  }
  return { move, eps };
}

function epsilonClosure(ids, index) {
  const seen = new Set(ids);
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop();
    for (const next of index.eps.get(id) || []) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return seen;
}

function startState(machine) {
  return machine.states.find(s => s.start) || null;
}

module.exports = {
  GREEK, renderLabel, parseSymbols, symbolsToLabel, isEpsilonToken,
  docToMachine, machineToDoc, normalize,
  alphabetOf, stateById, displayName, transitionIndex, epsilonClosure,
  startState
};
