#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const M = require('./machine');
const { analyze, summarize } = require('./analyze');
const { simulate, describeRun, testStrings, describeTests } = require('./simulate');
const { convert, CONVERSIONS } = require('./convert');
const { compare, sampleLanguage } = require('./equivalence');
const { layout } = require('./layout');
const { render } = require('./render');
const { animate } = require('./animate');
const store = require('./store');
const bridge = require('./bridge');

const SERVER = { name: 'fsm-designer', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2024-11-05';
const OUT_DIR = path.join(store.DIR, 'out');

/* ------------------------------------------------------------------ *
 * Resolving which machine a tool is talking about
 * ------------------------------------------------------------------ */

/*
 * Tools take a machine one of three ways, in this order: spelled out in the
 * call, by the name it was saved under, or -- the common case -- whatever is
 * currently open in the designer. Defaulting to the open diagram is what lets
 * a user just ask "is my machine right?" without describing it first.
 */
function resolveMachine(args = {}) {
  if (args.machine) {
    const m = M.normalize(args.machine);
    if (!m.states.length) throw new Error('That machine has no states.');
    return { machine: m, source: 'argument' };
  }
  if (args.name) {
    const doc = store.getNamed(args.name);
    if (!doc) {
      throw new Error(`No saved machine called "${args.name}". Saved: ${store.listNamed().join(', ') || '(none)'}`);
    }
    return { machine: M.docToMachine(doc, args.name), source: `saved:${args.name}` };
  }
  const current = store.get();
  const machine = M.docToMachine(current.doc, 'current');
  if (!machine.states.length) {
    throw new Error(
      'The designer has no diagram yet. Draw one and it will sync, pass a machine directly, ' +
      'or call open_designer to launch the editor.'
    );
  }
  return { machine, source: 'designer' };
}

function writeOut(name, text) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function safeName(str, fallback) {
  const base = String(str || fallback || 'machine')
    .replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return base || fallback || 'machine';
}

function machineOutline(m) {
  const lines = [`States (${m.states.length}):`];
  for (const s of m.states) {
    const marks = [s.start ? 'start' : null, s.accepting ? 'accepting' : null]
      .filter(Boolean).join(', ');
    lines.push(`  ${s.name}${marks ? `  [${marks}]` : ''}`);
  }
  lines.push(`Transitions (${m.transitions.length}):`);
  for (const t of m.transitions) {
    const on = t.epsilon
      ? (t.symbols.length ? `${t.symbols.join(',')},ε` : 'ε')
      : (t.symbols.join(',') || '(unlabelled)');
    lines.push(`  ${M.displayName(m, t.from)} --${on}--> ${M.displayName(m, t.to)}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'get_machine',
    description:
      'Read the finite state machine currently open in the FSM Designer and return it as structured data ' +
      'plus a readable outline. Use this to see a user\'s own construction without asking for a screenshot. ' +
      'Requires the designer to be connected (see open_designer).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run() {
      const current = store.get();
      const machine = M.docToMachine(current.doc, 'current');
      if (!machine.states.length) {
        return text('The designer is connected but the canvas is empty.\n\n' +
          'Run open_designer to get the editor URL, or pass a machine directly to the other tools.');
      }
      const report = analyze(machine);
      return json({
        machine: plain(machine),
        analysis: report
      }, `${machineOutline(machine)}\n\n${summarize(report)}`);
    }
  },

  {
    name: 'set_machine',
    description:
      'Replace the diagram in the FSM Designer with a machine you specify. Positions are computed ' +
      'automatically unless states carry x/y. The user sees it appear in their editor within about a second. ' +
      'Use this to hand back a correction, a worked example, or a converted machine they can keep editing.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: machineSchema(),
        relayout: { type: 'boolean', description: 'Recompute positions even if states have coordinates. Default true when no coordinates are given.' }
      },
      required: ['machine'],
      additionalProperties: false
    },
    run(args) {
      let m = M.normalize(args.machine);
      if (!m.states.length) throw new Error('That machine has no states.');
      const hasCoords = m.states.every(s => typeof s.x === 'number' && typeof s.y === 'number');
      if (args.relayout || !hasCoords) m = layout(m);
      const doc = M.machineToDoc(m);
      store.set(doc, 'claude');
      bridge.pushed();
      const status = bridge.status();
      return text(
        `Pushed "${m.name}" to the designer (${m.states.length} states, ${m.transitions.length} transitions).\n` +
        (status.running
          ? `Open editor: ${status.url}`
          : 'The designer is not being served yet — call open_designer and the diagram will be waiting.')
      );
    }
  },

  {
    name: 'describe_machine',
    description:
      'Analyse a machine and report what it is and what is wrong with it: alphabet, whether it is a DFA, NFA ' +
      'or ε-NFA, unreachable states, states that can never accept, nondeterministic choices, missing ' +
      'transitions, duplicate labels and unlabelled arrows. This is the tool for "look at my construction ' +
      'and tell me what is off".',
    inputSchema: {
      type: 'object',
      properties: { machine: machineSchema(), name: { type: 'string', description: 'A machine saved with save_machine.' } },
      additionalProperties: false
    },
    run(args) {
      const { machine, source } = resolveMachine(args);
      const report = analyze(machine);
      return json({ source, analysis: report, machine: plain(machine) },
        `${machineOutline(machine)}\n\n${summarize(report)}`);
    }
  },

  {
    name: 'simulate',
    description:
      'Run one input string through a machine and return the whole trace, step by step, including exactly ' +
      'where a rejected string falls off. Works on DFAs, NFAs and ε-NFAs (the trace tracks the whole set of ' +
      'live states).',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The string to run. Use "" for the empty string.' },
        machine: machineSchema(),
        name: { type: 'string' }
      },
      required: ['input'],
      additionalProperties: false
    },
    run(args) {
      const { machine } = resolveMachine(args);
      const run = simulate(machine, args.input);
      return json({ result: run }, describeRun(run));
    }
  },

  {
    name: 'test_strings',
    description:
      'Check a batch of strings against what the user says should happen, and return a full trace for every ' +
      'failure. This is the fastest way to show someone *why* their construction is wrong rather than just ' +
      'that it is.',
    inputSchema: {
      type: 'object',
      properties: {
        cases: {
          type: 'array',
          description: 'Strings to test. Either plain strings, or objects with an expected verdict.',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  input: { type: 'string' },
                  expect: { type: 'string', enum: ['accept', 'reject'] }
                },
                required: ['input']
              }
            ]
          }
        },
        machine: machineSchema(),
        name: { type: 'string' }
      },
      required: ['cases'],
      additionalProperties: false
    },
    run(args) {
      const { machine } = resolveMachine(args);
      const report = testStrings(machine, args.cases);
      return json({ report: { ...report, results: report.results.map(stripRun) } },
        describeTests(report));
    }
  },

  {
    name: 'convert',
    description:
      'Convert a machine and return both the result and the ordered steps that produced it. ' +
      'nfa_to_dfa runs the subset construction, remove_epsilon folds away ε-moves, minimize does partition ' +
      'refinement (DFA only), complement completes then flips accepting states, reverse turns every arrow ' +
      'around. Pair with animate_conversion to show the working.',
    inputSchema: {
      type: 'object',
      properties: {
        conversion: { type: 'string', enum: Object.keys(CONVERSIONS) },
        machine: machineSchema(),
        name: { type: 'string' },
        push: { type: 'boolean', description: 'Also put the result into the designer. Default false.' }
      },
      required: ['conversion'],
      additionalProperties: false
    },
    run(args) {
      const { machine } = resolveMachine(args);
      const result = convert(machine, args.conversion);
      const laid = layout(result.machine);
      if (args.push) {
        store.set(M.machineToDoc(laid), 'claude');
        bridge.pushed();
      }
      const lines = [result.note, '', machineOutline(laid), '', 'Steps:'];
      result.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.description}`));
      if (args.push) lines.push('', 'Pushed to the designer.');
      return json({ machine: plain(laid), steps: result.steps, note: result.note },
        lines.join('\n'));
    }
  },

  {
    name: 'compare_machines',
    description:
      'Decide whether two machines accept the same language. When they differ it returns the SHORTEST string ' +
      'they disagree on, which is the useful part: the user can trace that one string through their own ' +
      'drawing to find the mistake. Determinises both sides first, so NFAs and ε-NFAs are fine.',
    inputSchema: {
      type: 'object',
      properties: {
        first: machineSchema('The first machine. Defaults to the diagram in the designer.'),
        second: machineSchema('The second machine.'),
        firstName: { type: 'string', description: 'Name of a saved machine to use as the first.' },
        secondName: { type: 'string', description: 'Name of a saved machine to use as the second.' }
      },
      additionalProperties: false
    },
    run(args) {
      const a = resolveMachine({ machine: args.first, name: args.firstName });
      const b = resolveMachine({ machine: args.second, name: args.secondName });
      const result = compare(a.machine, b.machine);
      const lines = [];
      if (result.equivalent === true) lines.push('Equivalent. ' + result.reason);
      else if (result.equivalent === false) lines.push('NOT equivalent. ' + result.reason);
      else lines.push('Undecided. ' + result.reason);

      if (result.distinguishingString != null) {
        const w = result.distinguishingString;
        lines.push('');
        lines.push(`Trace of "${w === '' ? 'ε' : w}" through the first machine:`);
        lines.push(describeRun(simulate(a.machine, w)));
        lines.push('');
        lines.push('Through the second:');
        lines.push(describeRun(simulate(b.machine, w)));
      }
      return json({ result }, lines.join('\n'));
    }
  },

  {
    name: 'sample_language',
    description:
      'List the shortest strings a machine accepts and rejects. Good for sanity-checking a construction ' +
      'against a description in words, and for showing a user what their machine actually does.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: machineSchema(),
        name: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 40 },
        maxLength: { type: 'integer', minimum: 1, maximum: 20 }
      },
      additionalProperties: false
    },
    run(args) {
      const { machine } = resolveMachine(args);
      const result = sampleLanguage(machine, { count: args.count || 10, maxLength: args.maxLength });
      const show = list => list.map(s => s === '' ? 'ε' : s).join(', ') || '(none found)';
      return json({ result },
        `Accepts: ${show(result.accepted)}\nRejects: ${show(result.rejected)}`);
    }
  },

  {
    name: 'render_svg',
    description:
      'Draw a machine as an SVG, using the designer\'s own look: stadium-shaped states that stretch to fit ' +
      'their label, double outlines for accepting states. Optionally highlight particular states or ' +
      'transitions to point at part of a construction. Returns the SVG source and writes a file.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: machineSchema(),
        name: { type: 'string' },
        highlightStates: { type: 'array', items: { type: 'string' }, description: 'State names to pick out in colour.' },
        title: { type: 'string' },
        relayout: { type: 'boolean', description: 'Recompute positions. Default true when the machine has none.' }
      },
      additionalProperties: false
    },
    run(args) {
      let { machine } = resolveMachine(args);
      const hasCoords = machine.states.every(s => typeof s.x === 'number' && typeof s.y === 'number');
      if (args.relayout || !hasCoords) machine = layout(machine);

      const ids = (args.highlightStates || []).map(n => {
        const s = machine.states.find(x => x.name === n || x.id === n);
        return s ? s.id : n;
      });
      const out = render(machine, { highlightStates: ids, title: args.title });
      const file = writeOut(`${safeName(machine.name, 'machine')}.svg`, out.svg);
      return json({ file, width: out.width, height: out.height, svg: out.svg },
        `Wrote ${file} (${out.width}x${out.height}).\n\n${out.svg}`);
    }
  },

  {
    name: 'animate_run',
    description:
      'Build an animation of a string being read: the current states light up symbol by symbol, with the ' +
      'input tape showing what has been consumed. Writes a self-contained HTML file with play, step and ' +
      'scrub controls. Use this to show someone how their machine behaves on an input it gets wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string' },
        machine: machineSchema(),
        name: { type: 'string' },
        speed: { type: 'integer', minimum: 200, maximum: 5000, description: 'Milliseconds per frame. Default 1100.' }
      },
      required: ['input'],
      additionalProperties: false
    },
    run(args) {
      const { machine } = resolveMachine(args);
      const { anim, html } = animate(machine, { kind: 'trace', input: args.input, speed: args.speed });
      const file = writeOut(`${safeName(machine.name, 'machine')}-run-${safeName(args.input, 'empty')}.html`, html);
      return text(
        `${anim.title}\n${anim.accepted ? 'Accepted' : 'Rejected'} — ${anim.frames.length} frames.\n\n` +
        `Animation: ${file}\n(open it in a browser; it needs no network)\n\n` +
        describeRun(anim.run)
      );
    }
  },

  {
    name: 'animate_conversion',
    description:
      'Build an animation of a conversion being carried out — for nfa_to_dfa each subset appears as it is ' +
      'discovered, and the captions explain each step. Writes a self-contained HTML file with play, step ' +
      'and scrub controls. This is the tool for teaching how a construction works, not just its answer.',
    inputSchema: {
      type: 'object',
      properties: {
        conversion: { type: 'string', enum: Object.keys(CONVERSIONS) },
        machine: machineSchema(),
        name: { type: 'string' },
        speed: { type: 'integer', minimum: 200, maximum: 5000 }
      },
      required: ['conversion'],
      additionalProperties: false
    },
    run(args) {
      const { machine } = resolveMachine(args);
      const { anim, html } = animate(machine, { kind: args.conversion, speed: args.speed });
      const file = writeOut(
        `${safeName(machine.name, 'machine')}-${safeName(args.conversion)}.html`, html);
      const lines = [anim.title, anim.result.note, '', `${anim.frames.length} frames.`, '',
        `Animation: ${file}`, '(open it in a browser; it needs no network)', '', 'Steps:'];
      anim.result.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.description}`));
      return text(lines.join('\n'));
    }
  },

  {
    name: 'open_designer',
    description:
      'Start the local server that hosts the FSM Designer and keeps it in sync with these tools, and return ' +
      'the URL for the user to open. Anything they draw becomes visible to get_machine; anything pushed with ' +
      'set_machine appears in their editor. Call this first in a session that involves the user\'s own drawing.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'integer', minimum: 1024, maximum: 65535, description: 'Default 4319.' } },
      additionalProperties: false
    },
    async run(args) {
      const existing = bridge.status();
      if (existing.running) {
        return text(`Already running at ${existing.url}\nOpen that in a browser; the diagram there syncs with these tools.`);
      }
      const { port } = await bridge.start(args.port);
      return text(
        `FSM Designer is now served at http://localhost:${port}/\n\n` +
        'Open that URL. The page syncs both ways: what the user draws is readable with get_machine, ' +
        'and set_machine updates what they see.\n\n' +
        'Note this is the local copy, not the published site — a page on https:// cannot talk to ' +
        'http://localhost, so the editor has to be served from here for syncing to work.'
      );
    }
  },

  {
    name: 'save_machine',
    description:
      'Keep a machine under a name so later calls can refer to it, for instance to compare a user\'s attempt ' +
      'against a reference. Saved machines persist between sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        as: { type: 'string', description: 'The name to save under.' },
        machine: machineSchema(),
        name: { type: 'string', description: 'Copy an existing saved machine.' }
      },
      required: ['as'],
      additionalProperties: false
    },
    run(args) {
      const { machine } = resolveMachine(args);
      store.saveNamed(args.as, M.machineToDoc(layout(machine)));
      return text(`Saved as "${args.as}". Saved machines: ${store.listNamed().join(', ')}`);
    }
  },

  {
    name: 'list_machines',
    description: 'List the machines saved with save_machine, and say whether the designer is connected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run() {
      const names = store.listNamed();
      const current = M.docToMachine(store.get().doc, 'current');
      const status = bridge.status();
      return text(
        `Designer: ${status.running ? `served at ${status.url}` : 'not started (call open_designer)'}\n` +
        `Current diagram: ${current.states.length} states, ${current.transitions.length} transitions\n` +
        `Saved machines: ${names.join(', ') || '(none)'}`
      );
    }
  }
];

function machineSchema(description) {
  return {
    type: 'object',
    description: description ||
      'A machine given directly. Omit to use whatever is open in the designer.',
    properties: {
      name: { type: 'string' },
      states: {
        type: 'array',
        description: 'State names, or objects with name/accepting/start and optional x,y.',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                name: { type: 'string' },
                accepting: { type: 'boolean' },
                start: { type: 'boolean' },
                x: { type: 'number' },
                y: { type: 'number' }
              },
              required: ['name']
            }
          ]
        }
      },
      transitions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            on: {
              description: 'Symbol or list of symbols. Use "ε" (or omit and set epsilon) for an empty move.',
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
            },
            epsilon: { type: 'boolean' }
          },
          required: ['from', 'to']
        }
      },
      start: { type: 'string', description: 'Name of the start state, if not marked on the state itself.' },
      accepting: { type: 'array', items: { type: 'string' }, description: 'Accepting state names.' }
    },
    required: ['states', 'transitions']
  };
}

function plain(m) {
  return {
    name: m.name,
    states: m.states.map(s => ({
      name: s.name, accepting: s.accepting, start: s.start,
      x: s.x == null ? undefined : Math.round(s.x),
      y: s.y == null ? undefined : Math.round(s.y)
    })),
    transitions: m.transitions.map(t => ({
      from: M.displayName(m, t.from),
      to: M.displayName(m, t.to),
      on: t.symbols,
      epsilon: t.epsilon || undefined
    }))
  };
}

function stripRun(r) {
  return { input: r.input, expected: r.expected, actual: r.actual, pass: r.pass };
}

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

// Readable prose first, then the structured data, so the model can answer
// directly but still has exact values to work from.
function json(data, prose) {
  return {
    content: [{
      type: 'text',
      text: (prose ? prose + '\n\n' : '') + '```json\n' + JSON.stringify(data, null, 2) + '\n```'
    }]
  };
}

/* ------------------------------------------------------------------ *
 * JSON-RPC over stdio
 *
 * Implemented directly rather than through the SDK so the server has no
 * dependencies at all: `node src/index.js` runs it, with nothing to install.
 * ------------------------------------------------------------------ */

const byName = new Map(TOOLS.map(t => [t.name, t]));

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: (params && typeof params.protocolVersion === 'string')
          ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER
      });
      return;

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, {
        tools: TOOLS.map(t => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema
        }))
      });
      return;

    case 'resources/list':
      reply(id, {
        resources: [{
          uri: 'fsm://current',
          name: 'Current diagram',
          description: 'The machine currently open in the FSM Designer, as JSON.',
          mimeType: 'application/json'
        }]
      });
      return;

    case 'resources/read': {
      const uri = params && params.uri;
      if (uri !== 'fsm://current') { fail(id, -32602, `Unknown resource: ${uri}`); return; }
      const machine = M.docToMachine(store.get().doc, 'current');
      reply(id, {
        contents: [{
          uri, mimeType: 'application/json',
          text: JSON.stringify({ machine: plain(machine), analysis: analyze(machine) }, null, 2)
        }]
      });
      return;
    }

    case 'prompts/list':
      reply(id, { prompts: [] });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const tool = byName.get(name);
      if (!tool) { fail(id, -32602, `Unknown tool: ${name}`); return; }
      try {
        const result = await tool.run(params.arguments || {});
        reply(id, result);
      } catch (err) {
        // Tool failures come back as content, not protocol errors, so the
        // model can read the message and correct itself.
        reply(id, {
          content: [{ type: 'text', text: `Error: ${err && err.message ? err.message : String(err)}` }],
          isError: true
        });
      }
      return;
    }

    default:
      if (id !== undefined && id !== null) fail(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) {
        process.stderr.write(`fsm-designer: could not parse a message: ${e.message}\n`);
        continue;
      }
      Promise.resolve(handleMessage(msg)).catch(err => {
        process.stderr.write(`fsm-designer: ${err && err.stack ? err.stack : err}\n`);
      });
    }
  });
  process.stdin.on('end', () => { bridge.stop(); process.exit(0); });
  process.stderr.write(`fsm-designer MCP server ready (${TOOLS.length} tools)\n`);
}

if (require.main === module) {
  if (process.argv.includes('--serve')) {
    bridge.start(4319).then(({ port }) => {
      process.stderr.write(`Designer served at http://localhost:${port}/\n`);
    });
  } else {
    main();
  }
}

module.exports = { TOOLS, handleMessage, resolveMachine };
