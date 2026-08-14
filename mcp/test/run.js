'use strict';

/* Self-check: node mcp/test/run.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../src/machine');
const { analyze } = require('../src/analyze');
const { simulate, testStrings } = require('../src/simulate');
const { convert } = require('../src/convert');
const { compare, sampleLanguage } = require('../src/equivalence');
const { layout } = require('../src/layout');
const R = require('../src/render');
const { render } = R;
const { animate } = require('../src/animate');
const { handleMessage } = require('../src/index');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

/* --- fixtures --- */

// Strings over {0,1} ending in "01". Classic NFA with a self-loop on the start.
const endsIn01 = {
  name: 'ends in 01',
  states: [{ name: 'q0', start: true }, { name: 'q1' }, { name: 'q2', accepting: true }],
  transitions: [
    { from: 'q0', to: 'q0', on: ['0', '1'] },
    { from: 'q0', to: 'q1', on: '0' },
    { from: 'q1', to: 'q2', on: '1' }
  ]
};

// The same language, as a DFA.
const endsIn01Dfa = {
  name: 'ends in 01 (dfa)',
  states: [{ name: 'A', start: true }, { name: 'B' }, { name: 'C', accepting: true }],
  transitions: [
    { from: 'A', to: 'B', on: '0' }, { from: 'A', to: 'A', on: '1' },
    { from: 'B', to: 'B', on: '0' }, { from: 'B', to: 'C', on: '1' },
    { from: 'C', to: 'B', on: '0' }, { from: 'C', to: 'A', on: '1' }
  ]
};

const withEpsilon = {
  name: 'eps',
  states: [{ name: 's', start: true }, { name: 'a' }, { name: 'b', accepting: true }],
  transitions: [
    { from: 's', to: 'a', epsilon: true },
    { from: 'a', to: 'b', on: '1' }
  ]
};

console.log('machine model');
test('normalize infers a start state', () => {
  const m = M.normalize({ states: ['x', 'y'], transitions: [] });
  assert.strictEqual(m.states[0].start, true);
});
test('label symbols split on commas', () => {
  const p = M.parseSymbols('0, 1');
  assert.deepStrictEqual(p.symbols, ['0', '1']);
});
test('epsilon spellings all mean the empty move', () => {
  for (const spelling of ['ε', '\\epsilon', 'eps', 'lambda']) {
    assert.strictEqual(M.parseSymbols(spelling).epsilon, true, spelling);
  }
});
test('greek and subscripts render for display', () => {
  assert.strictEqual(M.renderLabel('q_0'), 'q₀');
  assert.strictEqual(M.renderLabel('\\alpha'), 'α');
  assert.strictEqual(M.renderLabel('q_a'), 'q_a');   // no unicode subscript a
});
test('document round-trips through the machine model', () => {
  const doc = M.machineToDoc(layout(M.normalize(endsIn01)));
  const back = M.docToMachine(doc, 'rt');
  assert.strictEqual(back.states.length, 3);
  assert.strictEqual(back.transitions.length, 3);
  assert.strictEqual(back.states.filter(s => s.start).length, 1);
  assert.strictEqual(back.states.filter(s => s.accepting).length, 1);
});

console.log('analysis');
test('spots nondeterminism', () => {
  const r = analyze(endsIn01);
  assert.strictEqual(r.deterministic, false);
  assert.ok(r.nondeterministic.some(n => n.state === 'q0' && n.symbol === '0'));
});
test('calls a DFA a DFA', () => {
  assert.strictEqual(analyze(endsIn01Dfa).deterministic, true);
});
test('finds unreachable states', () => {
  const r = analyze({
    states: [{ name: 'a', start: true }, { name: 'lost', accepting: true }],
    transitions: [{ from: 'a', to: 'a', on: '0' }]
  });
  assert.deepStrictEqual(r.unreachable, ['lost']);
});
test('finds states that can never accept', () => {
  const r = analyze({
    states: [{ name: 'a', start: true }, { name: 'trap' }, { name: 'f', accepting: true }],
    transitions: [
      { from: 'a', to: 'f', on: '1' },
      { from: 'a', to: 'trap', on: '0' },
      { from: 'trap', to: 'trap', on: ['0', '1'] }
    ]
  });
  assert.deepStrictEqual(r.deadStates, ['trap']);
});
test('flags a drawing with no start arrow', () => {
  // Two states, an arrow between them, but nothing marking the start.
  const m = M.docToMachine({
    nodes: [{ text: 'a' }, { text: 'b', isAcceptState: true }],
    links: [{ type: 'Link', nodeA: 0, nodeB: 1, text: '1' }]
  });
  const r = analyze(m);
  assert.ok(r.issues.some(i => i.kind === 'no-start'),
    'a missing start arrow must be reported, not silently invented');
  assert.strictEqual(r.start, 'a', 'but analysis still proceeds from an assumed start');
});
test('a drawing with a start arrow is not flagged', () => {
  const m = M.docToMachine({
    nodes: [{ text: 'a' }, { text: 'b', isAcceptState: true }],
    links: [
      { type: 'StartLink', node: 0, text: '' },
      { type: 'Link', nodeA: 0, nodeB: 1, text: '1' }
    ]
  });
  assert.ok(!analyze(m).issues.some(i => i.kind === 'no-start'));
});
test('a hand-written machine that marks its start is not flagged', () => {
  assert.ok(!analyze(endsIn01).issues.some(i => i.kind === 'no-start'));
});
test('detects epsilon moves', () => {
  assert.strictEqual(analyze(withEpsilon).hasEpsilon, true);
});

console.log('simulation');
test('accepts and rejects correctly', () => {
  assert.strictEqual(simulate(endsIn01, '01').accepted, true);
  assert.strictEqual(simulate(endsIn01, '1101').accepted, true);
  assert.strictEqual(simulate(endsIn01, '010').accepted, false);
  assert.strictEqual(simulate(endsIn01, '').accepted, false);
});
test('follows epsilon moves from the start', () => {
  assert.strictEqual(simulate(withEpsilon, '1').accepted, true);
});
test('reports where a run dies', () => {
  const r = simulate(endsIn01Dfa, '0z1');
  assert.ok(r.stuckAt, 'should record the point of failure');
  assert.strictEqual(r.stuckAt.symbol, 'z');
});
test('trace records every step', () => {
  const r = simulate(endsIn01, '101');
  assert.strictEqual(r.steps.length, 4);   // start plus one per symbol
});
test('batch tests report failures with traces', () => {
  const r = testStrings(endsIn01, [
    { input: '01', expect: 'accept' },
    { input: '10', expect: 'accept' }      // deliberately wrong
  ]);
  assert.strictEqual(r.passed, 1);
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(r.failures[0].input, '10');
});

console.log('conversions');
test('subset construction yields a DFA', () => {
  const { machine, steps } = convert(endsIn01, 'nfa_to_dfa');
  assert.strictEqual(analyze(machine).deterministic, true);
  assert.ok(steps.length > 0);
});
test('determinised machine accepts the same language', () => {
  const { machine } = convert(endsIn01, 'nfa_to_dfa');
  assert.strictEqual(compare(endsIn01, machine).equivalent, true);
});
test('epsilon removal preserves the language', () => {
  const { machine } = convert(withEpsilon, 'remove_epsilon');
  assert.strictEqual(analyze(machine).hasEpsilon, false);
  assert.strictEqual(compare(withEpsilon, machine).equivalent, true);
});
test('minimisation preserves the language and does not grow', () => {
  const dfa = convert(endsIn01, 'nfa_to_dfa').machine;
  const min = convert(dfa, 'minimize').machine;
  assert.strictEqual(compare(dfa, min).equivalent, true);
  assert.ok(min.states.length <= dfa.states.length);
});
test('minimisation refuses a nondeterministic machine', () => {
  assert.throws(() => convert(endsIn01, 'minimize'), /DFA/);
});
test('complement flips membership', () => {
  const { machine } = convert(endsIn01Dfa, 'complement');
  assert.strictEqual(simulate(machine, '01').accepted, false);
  assert.strictEqual(simulate(machine, '10').accepted, true);
  assert.strictEqual(simulate(machine, '').accepted, true);
});
test('reverse of "ends in 01" starts with 10', () => {
  const { machine } = convert(endsIn01Dfa, 'reverse');
  assert.strictEqual(simulate(machine, '10').accepted, true);
  assert.strictEqual(simulate(machine, '01').accepted, false);
});

console.log('equivalence');
test('equivalent machines are recognised', () => {
  assert.strictEqual(compare(endsIn01, endsIn01Dfa).equivalent, true);
});
test('a difference yields the shortest witness', () => {
  const almost = JSON.parse(JSON.stringify(endsIn01Dfa));
  almost.transitions.find(t => t.from === 'B' && t.on === '1').to = 'A';  // break it
  const r = compare(endsIn01Dfa, almost);
  assert.strictEqual(r.equivalent, false);
  assert.strictEqual(typeof r.distinguishingString, 'string');
  // the witness must genuinely separate them
  assert.notStrictEqual(
    simulate(endsIn01Dfa, r.distinguishingString).accepted,
    simulate(almost, r.distinguishingString).accepted
  );
});
test('missing transitions count as a real difference', () => {
  const partial = {
    states: [{ name: 'a', start: true }, { name: 'b', accepting: true }],
    transitions: [{ from: 'a', to: 'b', on: '1' }]
  };
  const complete = {
    states: [{ name: 'a', start: true }, { name: 'b', accepting: true }],
    transitions: [{ from: 'a', to: 'b', on: ['1', '0'] }]
  };
  assert.strictEqual(compare(partial, complete).equivalent, false);
});
test('sample_language finds real members', () => {
  const s = sampleLanguage(endsIn01, { count: 5 });
  assert.ok(s.accepted.length > 0);
  for (const w of s.accepted) assert.strictEqual(simulate(endsIn01, w).accepted, true);
  for (const w of s.rejected) assert.strictEqual(simulate(endsIn01, w).accepted, false);
});

console.log('layout and rendering');
test('layout gives every state a position', () => {
  const m = layout(M.normalize(endsIn01));
  for (const s of m.states) {
    assert.strictEqual(typeof s.x, 'number');
    assert.strictEqual(typeof s.y, 'number');
  }
});
// Counts everything a reader would see as a collision.
function collisions(m) {
  const boxes = require('../src/render').labelBoxes(m);
  const overlap = require('../src/render').overlap;
  const labels = boxes.filter(b => b.kind === 'label' && !b.empty);
  const states = boxes.filter(b => b.kind === 'state');
  let n = 0;
  for (let i = 0; i < labels.length; i++) {
    for (const s of states) if (overlap(labels[i], s) > 0.5) n++;
    for (let j = i + 1; j < labels.length; j++) if (overlap(labels[i], labels[j]) > 0.5) n++;
  }
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) if (overlap(states[i], states[j]) > 0.5) n++;
  }
  return n;
}

test('laid-out machines have no overlapping labels or states', () => {
  const cases = [
    endsIn01,
    convert(endsIn01, 'nfa_to_dfa').machine,
    withEpsilon,
    // a denser machine: every state loops and talks to the next
    {
      states: [{ name: 'a', start: true }, { name: 'b' }, { name: 'c' }, { name: 'd', accepting: true }],
      transitions: [
        { from: 'a', to: 'a', on: '0' }, { from: 'a', to: 'b', on: '1' },
        { from: 'b', to: 'b', on: '1' }, { from: 'b', to: 'c', on: '0' },
        { from: 'c', to: 'c', on: '0' }, { from: 'c', to: 'd', on: '1' },
        { from: 'd', to: 'a', on: '0' }, { from: 'c', to: 'a', on: '1' }
      ]
    },
    // long names, which stretch states into wide pills
    {
      states: [{ name: 'WaitingForInput', start: true }, { name: 'ProcessingRequest' },
        { name: 'Done', accepting: true }],
      transitions: [
        { from: 'WaitingForInput', to: 'ProcessingRequest', on: 'go' },
        { from: 'ProcessingRequest', to: 'WaitingForInput', on: 'retry' },
        { from: 'ProcessingRequest', to: 'Done', on: 'ok' }
      ]
    }
  ];
  for (const c of cases) {
    const m = layout(M.normalize(c));
    assert.strictEqual(collisions(m), 0, `overlaps in ${m.name}`);
  }
});
test('no arrow is drawn through a label', () => {
  const L = require('../src/layout');
  const cases = [endsIn01, convert(endsIn01, 'nfa_to_dfa').machine, endsIn01Dfa, {
    states: [{ name: 'a', start: true }, { name: 'b' }, { name: 'c' }, { name: 'd', accepting: true }],
    transitions: [
      { from: 'a', to: 'b', on: '0' }, { from: 'b', to: 'a', on: '1' },
      { from: 'b', to: 'c', on: '0' }, { from: 'c', to: 'b', on: '1' },
      { from: 'c', to: 'd', on: '0' }, { from: 'a', to: 'd', on: '1' },
      { from: 'd', to: 'b', on: '0' }
    ]
  }];
  for (const c of cases) {
    const m = layout(M.normalize(c));
    const paths = R.transitionPaths(m);
    const labels = R.labelBoxes(m).filter(b => b.kind === 'label' && !b.empty);
    for (const label of labels) {
      for (const p of paths) {
        if (p.transition === label.transition) continue;
        assert.ok(!L.pathCrossesBox(p, label),
          `an arrow runs through the label "${label.transition.label}" in ${m.name}`);
      }
    }
  }
});
test('no arrow passes between a label and its own line', () => {
  const L = require('../src/layout');
  const cases = [endsIn01, convert(endsIn01, 'nfa_to_dfa').machine, endsIn01Dfa, {
    states: [{ name: 'a', start: true }, { name: 'b' }, { name: 'c' }, { name: 'd', accepting: true }],
    transitions: [
      { from: 'a', to: 'b', on: '0' }, { from: 'b', to: 'a', on: '1' },
      { from: 'b', to: 'c', on: '0' }, { from: 'c', to: 'd', on: '1' },
      { from: 'a', to: 'd', on: '1' }, { from: 'd', to: 'b', on: '0' }
    ]
  }];
  for (const c of cases) {
    const m = layout(M.normalize(c));
    const paths = R.transitionPaths(m);
    const labels = R.labelBoxes(m).filter(b => b.kind === 'label' && !b.empty);
    for (const label of labels) {
      for (const p of paths) {
        if (p.index === label.index) continue;
        assert.ok(!L.crossesTether(p, label),
          `an arrow cuts between the label "${label.transition.label}" and its line in ${m.name}`);
      }
    }
  }
});
test('arrows do not cross close to a state', () => {
  const L = require('../src/layout');
  const cases = [endsIn01, convert(endsIn01, 'nfa_to_dfa').machine, endsIn01Dfa, {
    states: [{ name: 'a', start: true }, { name: 'b' }, { name: 'c' }, { name: 'd', accepting: true }],
    transitions: [
      { from: 'a', to: 'c', on: '0' }, { from: 'b', to: 'd', on: '1' },
      { from: 'a', to: 'd', on: '1' }, { from: 'b', to: 'c', on: '0' },
      { from: 'c', to: 'a', on: '1' }
    ]
  }];
  for (const c of cases) {
    const m = layout(M.normalize(c));
    const bad = L.crossingsNearStates(m);
    assert.strictEqual(bad.length, 0,
      `${bad.length} crossing(s) near a state in ${m.name}` +
      (bad[0] ? ` (${Math.round(bad[0].distance)}px away)` : ""));
  }
});
test('untangling actually moves something when it must', () => {
  const L = require('../src/layout');
  // Force a tangle, then confirm the pass finds and removes it.
  const m = layout(M.normalize({
    states: [{ name: 'a', start: true }, { name: 'b' }, { name: 'c' }, { name: 'd', accepting: true }],
    transitions: [
      { from: 'a', to: 'd', on: '0' }, { from: 'b', to: 'c', on: '1' },
      { from: 'a', to: 'c', on: '1' }, { from: 'b', to: 'd', on: '0' }
    ]
  }));
  assert.strictEqual(L.crossingsNearStates(m).length, 0);
  // and the fix did not push an arrow through a state instead
  const paths = R.transitionPaths(m);
  for (const p of paths) {
    for (const s of m.states) {
      if (s.id === p.transition.from || s.id === p.transition.to) continue;
      const half = R.halfWidthFor(s.label != null ? s.label : s.name);
      for (const pt of p.points) {
        const cx = Math.max(s.x - half, Math.min(s.x + half, pt.x));
        assert.ok(Math.hypot(pt.x - cx, pt.y - s.y) >= R.NODE_RADIUS,
          'untangling pushed an arrow through a state');
      }
    }
  }
});
test('wide states get columns wide enough not to touch', () => {
  const m = layout(M.normalize({
    states: [{ name: 'AVeryLongStateName', start: true }, { name: 'AnotherLongOne', accepting: true }],
    transitions: [{ from: 'AVeryLongStateName', to: 'AnotherLongOne', on: '1' }]
  }));
  const gap = Math.abs(m.states[1].x - m.states[0].x)
    - R.halfWidthFor('AVeryLongStateName') - R.halfWidthFor('AnotherLongOne')
    - R.NODE_RADIUS * 2;
  assert.ok(gap > 40, `columns too close: ${Math.round(gap)}px`);
});
test('self-loops avoid the arrows already at a state', () => {
  // b has arrows in from a and out to c, both horizontal, plus a self-loop.
  const m = layout(M.normalize({
    states: [{ name: 'a', start: true }, { name: 'b' }, { name: 'c', accepting: true }],
    transitions: [
      { from: 'a', to: 'b', on: '1' }, { from: 'b', to: 'c', on: '1' },
      { from: 'b', to: 'b', on: '0' }
    ]
  }));
  const loop = m.transitions.find(t => t.from === t.to);
  // must not point along the horizontal, where the other two arrows run
  assert.ok(Math.abs(Math.cos(loop.anchorAngle)) < 0.9,
    `loop points along the incoming arrows (angle ${loop.anchorAngle})`);
});
test('row ordering reduces crossings', () => {
  // Deliberately declared in an order that crosses if left alone.
  const m = layout(M.normalize({
    states: [{ name: 's', start: true }, { name: 'x1' }, { name: 'x2' },
      { name: 'y1' }, { name: 'y2', accepting: true }],
    transitions: [
      { from: 's', to: 'x1', on: '0' }, { from: 's', to: 'x2', on: '1' },
      { from: 'x1', to: 'y1', on: '0' }, { from: 'x2', to: 'y2', on: '1' }
    ]
  }));
  const at = n => m.states.find(s => s.name === n);
  // x1->y1 and x2->y2 must not swap vertical order
  assert.strictEqual(
    Math.sign(at('x1').y - at('x2').y),
    Math.sign(at('y1').y - at('y2').y),
    'connected pairs should stay on the same side'
  );
});
test('opposite arrows bow apart', () => {
  const m = layout(M.normalize({
    states: [{ name: 'a', start: true }, { name: 'b', accepting: true }],
    transitions: [{ from: 'a', to: 'b', on: '1' }, { from: 'b', to: 'a', on: '0' }]
  }));
  assert.ok(m.transitions.every(t => t.perpendicularPart !== 0));
});
test('renders well-formed SVG', () => {
  const out = render(layout(M.normalize(endsIn01)));
  assert.ok(out.svg.startsWith('<svg'));
  assert.ok(out.svg.trim().endsWith('</svg>'));
  assert.ok(out.width > 0 && out.height > 0);
  assert.ok((out.svg.match(/<path/g) || []).length >= 3);
  assert.ok(out.svg.includes('q'), 'labels should appear');
});
test('a long label stretches its state into a pill', () => {
  const wide = render(layout(M.normalize({
    states: [{ name: 'WaitingForInput', start: true }], transitions: []
  })));
  const round = render(layout(M.normalize({
    states: [{ name: 'q', start: true }], transitions: []
  })));
  assert.ok(wide.width > round.width + 60, 'pill should be much wider');
});
test('accepting states get a second outline', () => {
  const one = render(layout(M.normalize({ states: [{ name: 'a', start: true }], transitions: [] })));
  const two = render(layout(M.normalize({ states: [{ name: 'a', start: true, accepting: true }], transitions: [] })));
  assert.ok((two.svg.match(/<path/g) || []).length > (one.svg.match(/<path/g) || []).length);
});
test('SVG escapes label text', () => {
  const out = render(layout(M.normalize({ states: [{ name: 'a<b&c', start: true }], transitions: [] })));
  assert.ok(out.svg.includes('&lt;'));
  assert.ok(!/<text[^>]*>[^<]*<b/.test(out.svg));
});

console.log('animation');
test('a run animates one frame per symbol plus a verdict', () => {
  const { anim, html } = animate(endsIn01, { kind: 'trace', input: '101' });
  assert.strictEqual(anim.frames.length, 5);   // start + 3 symbols + verdict
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(!/src="http/.test(html), 'must be self-contained');
});
test('a conversion animates its steps', () => {
  const { anim, html } = animate(endsIn01, { kind: 'nfa_to_dfa' });
  assert.ok(anim.frames.length > 2);
  assert.ok(html.includes('FRAMES'));
});
test('frames share one viewBox so the picture does not jump', () => {
  const { anim } = animate(endsIn01, { kind: 'nfa_to_dfa' });
  const boxes = anim.frames.slice(1).map(f => (f.svg.match(/viewBox="([^"]+)"/) || [])[1]);
  assert.strictEqual(new Set(boxes).size, 1);
});

console.log('MCP protocol');
function call(method, params) {
  return new Promise(resolve => {
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = chunk => { process.stdout.write = original; resolve(JSON.parse(chunk)); return true; };
    handleMessage({ jsonrpc: '2.0', id: 1, method, params });
  });
}

(async () => {
  const init = await call('initialize', { protocolVersion: '2024-11-05' });
  test('initialize answers with server info', () => {
    assert.strictEqual(init.result.serverInfo.name, 'fsm-designer');
    assert.ok(init.result.capabilities.tools);
  });

  const list = await call('tools/list', {});
  test('every tool has a name, description and schema', () => {
    assert.ok(list.result.tools.length >= 12);
    for (const t of list.result.tools) {
      assert.ok(t.name && t.description, 'missing name or description');
      assert.strictEqual(t.inputSchema.type, 'object');
    }
  });

  const described = await call('tools/call', {
    name: 'describe_machine', arguments: { machine: endsIn01 }
  });
  test('describe_machine returns readable text and JSON', () => {
    const body = described.result.content[0].text;
    assert.ok(body.includes('NFA'));
    assert.ok(body.includes('```json'));
  });

  const bad = await call('tools/call', { name: 'convert', arguments: { conversion: 'nope', machine: endsIn01 } });
  test('a bad argument comes back as an error result, not a crash', () => {
    assert.strictEqual(bad.result.isError, true);
    assert.ok(bad.result.content[0].text.startsWith('Error:'));
  });

  const unknown = await call('tools/call', { name: 'no_such_tool', arguments: {} });
  test('an unknown tool is a protocol error', () => {
    assert.ok(unknown.error);
  });

  const res = await call('resources/read', { uri: 'fsm://current' });
  test('the current diagram is exposed as a resource', () => {
    assert.ok(res.result.contents[0].text.includes('machine'));
  });

  /* --- the bridge, over real HTTP --- */

  console.log('bridge');

  const bridge = require('../src/bridge');
  const started = await bridge.start(0);          // 0: let the OS pick a free port
  const origin = `http://127.0.0.1:${started.port}`;
  const token = started.token;

  const hello = await fetch(`${origin}/api/hello`);
  test('the reachability probe needs no token', () => {
    assert.strictEqual(hello.status, 200);
  });

  const bare = await fetch(`${origin}/api/machine`);
  test('the document is refused without a token', () => {
    assert.strictEqual(bare.status, 403);
  });

  const wrong = await fetch(`${origin}/api/machine`, { headers: { Authorization: 'Bearer nope' } });
  test('a wrong token is refused', () => {
    assert.strictEqual(wrong.status, 403);
  });

  const withHeader = await fetch(`${origin}/api/machine`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  test('a bearer token is accepted', () => {
    assert.strictEqual(withHeader.status, 200);
  });

  const withQuery = await fetch(`${origin}/api/machine?token=${token}`);
  test('a token in the query string is accepted, for curl', () => {
    assert.strictEqual(withQuery.status, 200);
  });

  const preflight = await fetch(`${origin}/api/machine`, { method: 'OPTIONS' });
  test('the preflight allows Authorization and answers Private Network Access', () => {
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /Authorization/i);
    assert.strictEqual(preflight.headers.get('access-control-allow-private-network'), 'true');
    assert.ok(Number(preflight.headers.get('access-control-max-age')) > 0);
  });

  const page = await (await fetch(`${origin}/`)).text();
  test('the page gets the token before the script that reads it', () => {
    const global = page.indexOf('window.__fsmBridge');
    const script = page.indexOf('bridge-client.js');
    assert.ok(global > -1 && script > -1, 'both should be present');
    assert.ok(global < script, 'the token must be defined first');
    assert.ok(page.includes(token));
  });

  test('the client is not injected twice', () => {
    assert.strictEqual(page.split('src="bridge-client.js"').length - 1, 1);
  });

  // The linked URL only works if the client can parse what the server writes.
  // Lift the pattern straight out of the client so the two cannot drift apart.
  test('the linked URL parses with the client\'s own pattern', () => {
    const client = fs.readFileSync(path.join(__dirname, '..', '..', 'bridge-client.js'), 'utf8');
    const found = /(\/\[#&\]bridge=.*?\/i)\.exec\(window\.location\.hash/.exec(client);
    assert.ok(found, 'could not find the fragment pattern in bridge-client.js');

    const pattern = eval(found[1]);               // a regex literal from our own source
    const match = pattern.exec(new URL(bridge.status().linkedUrl).hash);
    assert.ok(match, 'the client would not parse the link the server hands out');
    assert.strictEqual(match[1], String(started.port));
    assert.strictEqual(match[2], token);
  });

  bridge.stop();
  test('stopping retires the token', () => {
    assert.strictEqual(bridge.status().token, null);
    assert.strictEqual(bridge.status().linkedUrl, null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
