'use strict';

const M = require('./machine');

/*
 * Running an input through the machine, tracking the whole frontier so this
 * works unchanged on a DFA, an NFA, or an ε-NFA.
 *
 * The step record is what makes a rejection explainable: it says which states
 * were live before each symbol and which survived it, so the exact point where
 * a machine falls off its intended path is visible rather than guessed at.
 */

// Splits input into symbols. Multi-character symbols in the alphabet are
// matched first, so an alphabet of {ab, a} reads "ab" as one symbol.
function tokenize(input, alphabet) {
  const multi = alphabet.filter(s => s.length > 1).sort((a, b) => b.length - a.length);
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const hit = multi.find(s => input.startsWith(s, i));
    if (hit) { tokens.push(hit); i += hit.length; continue; }
    tokens.push(input[i]);
    i += 1;
  }
  return tokens;
}

function simulate(machine, input, options = {}) {
  const m = M.normalize(machine);
  const index = M.transitionIndex(m);
  const alphabet = M.alphabetOf(m);
  const name = id => M.displayName(m, id);
  const start = M.startState(m);

  if (!start) {
    return { input, accepted: false, error: 'This machine has no start state.', steps: [] };
  }

  const tokens = options.symbols || tokenize(input, alphabet);
  const unknown = tokens.filter(t => !alphabet.includes(t));

  let live = M.epsilonClosure([start.id], index);
  const steps = [{
    position: 0, symbol: null,
    states: [...live].map(name),
    note: live.size > 1 ? 'start state plus its ε-closure' : 'start state'
  }];

  let died = null;
  for (let i = 0; i < tokens.length; i++) {
    const sym = tokens[i];
    const next = new Set();
    for (const id of live) {
      for (const to of (index.move.get(id) || new Map()).get(sym) || []) next.add(to);
    }
    const closed = M.epsilonClosure([...next], index);

    steps.push({
      position: i + 1, symbol: sym,
      from: [...live].map(name),
      states: [...closed].map(name),
      consumed: tokens.slice(0, i + 1).join(''),
      remaining: tokens.slice(i + 1).join('')
    });

    if (!closed.size) {
      died = { at: i, symbol: sym, from: [...live].map(name) };
      live = closed;
      break;
    }
    live = closed;
  }

  const accepting = [...live].filter(id => {
    const s = M.stateById(m, id);
    return s && s.accepting;
  }).map(name);

  return {
    input,
    symbols: tokens,
    accepted: accepting.length > 0,
    finalStates: [...live].map(name),
    acceptingStatesReached: accepting,
    unknownSymbols: [...new Set(unknown)],
    stuckAt: died,
    steps
  };
}

function describeRun(result) {
  const lines = [];
  const shown = result.input === '' ? '(empty string)' : result.input;
  lines.push(`${shown}: ${result.accepted ? 'ACCEPTED' : 'REJECTED'}`);

  if (result.error) { lines.push(result.error); return lines.join('\n'); }
  if (result.unknownSymbols.length) {
    lines.push(`Symbols not in the alphabet: ${result.unknownSymbols.join(', ')}`);
  }

  for (const step of result.steps) {
    if (step.symbol == null) {
      lines.push(`  start -> {${step.states.join(', ')}}`);
    } else {
      lines.push(`  read '${step.symbol}': {${step.from.join(', ')}} -> {${step.states.join(', ')}}`);
    }
  }

  if (result.stuckAt) {
    lines.push(`  no transition on '${result.stuckAt.symbol}' from {${result.stuckAt.from.join(', ')}} -- the run dies here`);
  } else if (result.accepted) {
    lines.push(`  ends in accepting state(s): ${result.acceptingStatesReached.join(', ')}`);
  } else {
    lines.push(`  ends in {${result.finalStates.join(', ')}}, none of which accept`);
  }
  return lines.join('\n');
}

/*
 * Checks a batch of strings against what the user says should happen. The
 * failures, with their traces, are the actionable half of "is my construction
 * right?" -- so they are reported in full and the passes are just counted.
 */
function testStrings(machine, cases) {
  const results = cases.map(c => {
    const input = typeof c === 'string' ? c : String(c.input != null ? c.input : '');
    const expect = typeof c === 'string' ? null
      : (c.expect != null ? String(c.expect).toLowerCase() : null);
    const run = simulate(machine, input);
    const expected = expect === 'accept' || expect === 'accepted' || expect === 'true'
      ? true : (expect == null ? null : false);
    return {
      input,
      expected,
      actual: run.accepted,
      pass: expected == null ? null : expected === run.accepted,
      run
    };
  });

  const checked = results.filter(r => r.pass !== null);
  const failures = checked.filter(r => !r.pass);
  return {
    total: results.length,
    checked: checked.length,
    passed: checked.length - failures.length,
    failed: failures.length,
    results,
    failures
  };
}

function describeTests(report) {
  const lines = [];
  if (report.checked) {
    lines.push(`${report.passed}/${report.checked} expectations met.`);
  }
  for (const r of report.results) {
    const mark = r.pass === null ? '-' : (r.pass ? 'ok' : 'FAIL');
    const shown = r.input === '' ? '(empty)' : r.input;
    lines.push(`[${mark}] ${shown}: ${r.actual ? 'accepted' : 'rejected'}` +
      (r.expected == null ? '' : ` (expected ${r.expected ? 'accept' : 'reject'})`));
  }
  if (report.failures.length) {
    lines.push('');
    lines.push('Traces for the failures:');
    for (const f of report.failures) {
      lines.push(describeRun(f.run));
      lines.push('');
    }
  }
  return lines.join('\n');
}

module.exports = { simulate, describeRun, testStrings, describeTests, tokenize };
