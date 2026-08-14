'use strict';

const M = require('./machine');

/*
 * Everything that can be said about a machine without being told what it is
 * supposed to do. This is what turns "here is my drawing" into something
 * worth answering: which states can never be reached, where the machine is
 * nondeterministic, which symbol is missing from which state.
 */
function analyze(machine) {
  const m = M.normalize(machine);
  const index = M.transitionIndex(m);
  const alphabet = M.alphabetOf(m);
  const start = M.startState(m);
  const name = id => M.displayName(m, id);

  const issues = [];

  /* --- structural problems the drawing can have --- */

  const starts = m.states.filter(s => s.start);
  if (!starts.length || m.startInferred) {
    issues.push({ level: 'error', kind: 'no-start',
      message: m.startInferred && starts.length
        ? `No start arrow: nothing marks where the machine begins, so ${name(starts[0].id)} was assumed for the sake of analysis.`
        : 'No start state: nothing marks where the machine begins.' });
  } else if (m.startMarks > 1 || starts.length > 1) {
    issues.push({ level: 'error', kind: 'multiple-starts',
      message: `More than one start arrow (${starts.map(s => name(s.id)).join(', ')}). A machine has exactly one start state.` });
  }
  if (!m.states.some(s => s.accepting)) {
    issues.push({ level: 'warning', kind: 'no-accepting',
      message: 'No accepting state: this machine rejects every input.' });
  }

  const unnamed = m.states.filter(s => !s.name || !s.name.trim());
  if (unnamed.length) {
    issues.push({ level: 'info', kind: 'unnamed-states',
      message: `${unnamed.length} state(s) have no label.` });
  }

  const seenNames = new Map();
  for (const s of m.states) {
    const key = s.name.trim();
    if (!key) continue;
    seenNames.set(key, (seenNames.get(key) || 0) + 1);
  }
  const duplicates = [...seenNames].filter(([, n]) => n > 1).map(([k]) => k);
  if (duplicates.length) {
    issues.push({ level: 'warning', kind: 'duplicate-names',
      message: `Two or more states share a label (${duplicates.join(', ')}), which makes the diagram ambiguous to read.`,
      states: duplicates });
  }

  const unlabelled = m.transitions.filter(t => t.unlabelled);
  if (unlabelled.length) {
    issues.push({ level: 'warning', kind: 'unlabelled-transitions',
      message: `${unlabelled.length} transition(s) have no label, so it is unclear what they consume.`,
      transitions: unlabelled.map(t => `${name(t.from)} -> ${name(t.to)}`) });
  }

  /* --- reachability --- */

  const reachable = new Set();
  if (start) {
    const stack = [start.id];
    reachable.add(start.id);
    while (stack.length) {
      const id = stack.pop();
      const row = index.move.get(id) || new Map();
      const targets = [...row.values()].flat().concat(index.eps.get(id) || []);
      for (const to of targets) {
        if (!reachable.has(to)) { reachable.add(to); stack.push(to); }
      }
    }
  }
  const unreachable = m.states.filter(s => !reachable.has(s.id));
  if (unreachable.length) {
    issues.push({ level: 'warning', kind: 'unreachable',
      message: `Unreachable from the start state: ${unreachable.map(s => name(s.id)).join(', ')}.`,
      states: unreachable.map(s => s.id) });
  }

  /* --- states from which acceptance is impossible --- */

  const backwards = new Map(m.states.map(s => [s.id, []]));
  for (const t of m.transitions) {
    if (!backwards.has(t.to)) continue;
    backwards.get(t.to).push(t.from);
  }
  const canAccept = new Set(m.states.filter(s => s.accepting).map(s => s.id));
  const queue = [...canAccept];
  while (queue.length) {
    const id = queue.pop();
    for (const from of backwards.get(id) || []) {
      if (!canAccept.has(from)) { canAccept.add(from); queue.push(from); }
    }
  }
  const dead = m.states.filter(s => reachable.has(s.id) && !canAccept.has(s.id));
  if (dead.length) {
    issues.push({ level: 'info', kind: 'dead-states',
      message: `No path to an accepting state from: ${dead.map(s => name(s.id)).join(', ')}. That is fine for a trap state, and a bug otherwise.`,
      states: dead.map(s => s.id) });
  }

  /* --- determinism --- */

  const nondeterministic = [];
  for (const s of m.states) {
    const row = index.move.get(s.id) || new Map();
    for (const [sym, targets] of row) {
      if (targets.length > 1) {
        nondeterministic.push({
          state: name(s.id), symbol: sym,
          targets: targets.map(t => name(t))
        });
      }
    }
  }
  const epsilonMoves = m.transitions.filter(t => t.epsilon).map(t => ({
    from: name(t.from), to: name(t.to)
  }));

  const deterministic = !nondeterministic.length && !epsilonMoves.length;

  /* --- completeness (only meaningful for a DFA) --- */

  const missing = [];
  for (const s of m.states) {
    if (!reachable.has(s.id)) continue;
    const row = index.move.get(s.id) || new Map();
    for (const sym of alphabet) {
      if (!row.has(sym) || !row.get(sym).length) {
        missing.push({ state: name(s.id), symbol: sym });
      }
    }
  }
  if (missing.length && deterministic) {
    issues.push({ level: 'info', kind: 'incomplete',
      message: `${missing.length} (state, symbol) pair(s) have no transition. Reading one of those symbols there rejects immediately, which is often intended but worth checking.`,
      pairs: missing.slice(0, 40) });
  }

  return {
    name: m.name,
    stateCount: m.states.length,
    transitionCount: m.transitions.length,
    alphabet,
    start: start ? name(start.id) : null,
    accepting: m.states.filter(s => s.accepting).map(s => name(s.id)),
    deterministic,
    hasEpsilon: epsilonMoves.length > 0,
    complete: deterministic && missing.length === 0,
    nondeterministic,
    epsilonMoves,
    unreachable: unreachable.map(s => name(s.id)),
    deadStates: dead.map(s => name(s.id)),
    missingTransitions: missing,
    issues
  };
}

// A compact human summary; the structured report above carries the detail.
function summarize(report) {
  const lines = [];
  const kind = report.hasEpsilon ? 'ε-NFA' : (report.deterministic ? 'DFA' : 'NFA');
  lines.push(`${report.name}: ${kind}, ${report.stateCount} states, ${report.transitionCount} transitions.`);
  lines.push(`Alphabet: {${report.alphabet.join(', ')}}${report.alphabet.length ? '' : ' (empty)'}`);
  lines.push(`Start: ${report.start || 'none'}   Accepting: ${report.accepting.join(', ') || 'none'}`);

  if (report.nondeterministic.length) {
    lines.push('Nondeterministic choices:');
    for (const n of report.nondeterministic.slice(0, 20)) {
      lines.push(`  ${n.state} --${n.symbol}--> {${n.targets.join(', ')}}`);
    }
  }
  if (report.issues.length) {
    lines.push('Findings:');
    for (const i of report.issues) lines.push(`  [${i.level}] ${i.message}`);
  } else {
    lines.push('No structural problems found.');
  }
  return lines.join('\n');
}

module.exports = { analyze, summarize };
