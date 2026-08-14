'use strict';

const M = require('./machine');
const { render } = require('./render');
const { layout } = require('./layout');
const { convert } = require('./convert');
const { simulate } = require('./simulate');

/*
 * Animations, built as a list of pre-rendered SVG frames wrapped in a small
 * self-contained player.
 *
 * Frames are rendered here rather than animated in the browser because the
 * geometry -- where an arrow meets a stadium outline, which way a self-loop
 * bows -- is the same code that draws the still image. Playing back finished
 * pictures keeps one source of truth for how a machine looks.
 */

function frameSetup(machine) {
  const laid = layout(M.normalize(machine));
  const full = render(laid, { padding: 40 });
  return { machine: laid, viewBox: full.viewBox };
}

/* ------------------------------------------------------------------ *
 * Watching a string being read
 * ------------------------------------------------------------------ */

function traceFrames(machine, input) {
  const { machine: laid, viewBox } = frameSetup(machine);
  const run = simulate(laid, input);
  const byName = new Map(laid.states.map(s => [s.name, s.id]));
  const frames = [];

  run.steps.forEach((step, i) => {
    const live = (step.states || []).map(n => byName.get(n)).filter(Boolean);
    const prev = (step.from || []).map(n => byName.get(n)).filter(Boolean);

    // Light up the arrows that were actually taken on this symbol.
    const edges = [];
    if (step.symbol != null) {
      for (const t of laid.transitions) {
        if (prev.includes(t.from) && live.includes(t.to) && t.symbols.includes(step.symbol)) {
          edges.push(`${t.from}|${t.to}`);
        }
      }
    }

    const consumed = step.consumed != null ? step.consumed : '';
    const remaining = step.remaining != null ? step.remaining
      : (step.symbol == null ? (run.symbols || []).join('') : '');

    frames.push({
      svg: render(laid, {
        viewBox, highlightStates: live, highlightTransitions: edges
      }).svg,
      caption: step.symbol == null
        ? `Start in ${live.length > 1 ? 'the ε-closure of the start state' : 'the start state'}: {${step.states.join(', ')}}`
        : `Read '${step.symbol}' — {${(step.from || []).join(', ')}} → {${step.states.join(', ')}}`,
      consumed, remaining,
      index: i
    });
  });

  const verdict = run.error ? run.error
    : run.accepted
      ? `Accepted — finished in ${run.acceptingStatesReached.join(', ')}`
      : run.stuckAt
        ? `Rejected — no transition on '${run.stuckAt.symbol}' from {${run.stuckAt.from.join(', ')}}`
        : `Rejected — finished in {${run.finalStates.join(', ')}}, none accepting`;

  frames.push({
    svg: frames.length ? frames[frames.length - 1].svg : render(laid, { viewBox }).svg,
    caption: verdict,
    consumed: input, remaining: '',
    final: true, accepted: run.accepted,
    index: frames.length
  });

  return {
    frames,
    title: `${laid.name}: reading "${input === '' ? 'ε' : input}"`,
    accepted: run.accepted,
    run
  };
}

/* ------------------------------------------------------------------ *
 * Watching a conversion being built
 * ------------------------------------------------------------------ */

function conversionFrames(machine, kind) {
  const source = layout(M.normalize(machine));
  const result = convert(source, kind);
  const laid = layout(result.machine);
  const full = render(laid, { padding: 40 });
  const viewBox = full.viewBox;

  const frames = [];
  const before = render(source, { padding: 40 });
  frames.push({
    svg: before.svg,
    caption: `Before: ${source.name}`,
    index: 0
  });

  // Steps that only add a transition between states already on screen still
  // reveal something, so every step gets a frame; what accumulates is the set
  // of states and edges shown so far.
  const shownStates = new Set();
  const shownEdges = new Set();

  const allStates = new Set(laid.states.map(s => s.id));
  const stepsWithGeometry = result.steps.filter(s =>
    s.addedStates.length || s.addedTransitions.length || s.kind === 'partition' ||
    s.kind === 'flip' || s.kind === 'accepting' || s.kind === 'drop' || s.kind === 'trap');

  // Conversions that rewrite the machine wholesale (minimise, complement,
  // reverse) have no meaningful partial state, so they show the finished
  // machine while the captions walk through the reasoning.
  const incremental = kind === 'nfa_to_dfa';

  stepsWithGeometry.forEach((step, i) => {
    for (const id of step.addedStates) shownStates.add(id);
    for (const key of step.addedTransitions) shownEdges.add(key);

    let svg;
    if (incremental) {
      const ghost = [...allStates].filter(id => !shownStates.has(id));
      const hiEdges = (step.addedTransitions || []).map(k => {
        const [from, , to] = k.split('|');
        return `${from}|${to}`;
      });
      svg = render(laid, {
        viewBox, ghostStates: ghost,
        highlightStates: step.addedStates,
        highlightTransitions: hiEdges
      }).svg;
    } else {
      svg = render(laid, {
        viewBox,
        highlightStates: step.addedStates
      }).svg;
    }

    frames.push({ svg, caption: step.description, index: frames.length });
  });

  frames.push({
    svg: render(laid, { viewBox }).svg,
    caption: `Result: ${result.note}`,
    final: true,
    index: frames.length
  });

  return {
    frames,
    title: `${source.name} — ${kind.replace(/_/g, ' ')}`,
    result
  };
}

/* ------------------------------------------------------------------ *
 * The player
 * ------------------------------------------------------------------ */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function buildHtml(anim, options = {}) {
  const frames = anim.frames.map(f => ({
    svg: f.svg,
    caption: f.caption || '',
    consumed: f.consumed || '',
    remaining: f.remaining || '',
    final: !!f.final,
    accepted: !!f.accepted
  }));
  const speed = options.speed || 1100;
  const showTape = frames.some(f => f.consumed || f.remaining);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(anim.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 24px;
    font: 15px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
    background: #fff; color: #111;
    display: flex; flex-direction: column; align-items: center; gap: 14px;
  }
  h1 { font-size: 18px; font-weight: 600; margin: 0; text-align: center; }
  #stage {
    width: 100%; max-width: 960px; border: 1px solid #ddd; border-radius: 8px;
    background: #fff; overflow: auto; display: flex; justify-content: center;
  }
  #stage svg { max-width: 100%; height: auto; display: block; }
  #tape {
    font-family: "SFMono-Regular", Consolas, monospace; font-size: 20px;
    letter-spacing: 2px; min-height: 28px;
  }
  #tape .done { color: #1a56db; }
  #tape .todo { color: #999; }
  #caption {
    max-width: 860px; text-align: center; min-height: 44px; color: #333;
  }
  #caption.final { font-weight: 600; }
  #caption.accepted { color: #12693a; }
  #caption.rejected { color: #a12c2c; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
  button {
    font: inherit; padding: 6px 14px; border: 1px solid #d0d0d0;
    border-radius: 5px; background: #fafafa; cursor: pointer; color: #111;
  }
  button:hover { background: #f0f0f0; }
  button:disabled { opacity: .45; cursor: default; }
  #scrub { width: min(420px, 70vw); }
  #count { color: #666; font-variant-numeric: tabular-nums; min-width: 74px; text-align: center; }
</style>
</head>
<body>
<h1>${esc(anim.title)}</h1>
<div id="stage"></div>
${showTape ? '<div id="tape"></div>' : ''}
<div id="caption"></div>
<div class="controls">
  <button id="first" title="First">&#124;&#9664;</button>
  <button id="prev" title="Previous">&#9664;</button>
  <button id="play">Play</button>
  <button id="next" title="Next">&#9654;</button>
  <button id="last" title="Last">&#9654;&#124;</button>
  <input id="scrub" type="range" min="0" value="0">
  <span id="count"></span>
</div>

<script>
var FRAMES = ${JSON.stringify(frames)};
var SPEED = ${speed};
var i = 0, timer = null;

var stage = document.getElementById('stage');
var caption = document.getElementById('caption');
var tape = document.getElementById('tape');
var scrub = document.getElementById('scrub');
var count = document.getElementById('count');
var playBtn = document.getElementById('play');
scrub.max = String(FRAMES.length - 1);

function show(k) {
  i = Math.max(0, Math.min(FRAMES.length - 1, k));
  var f = FRAMES[i];
  stage.innerHTML = f.svg;
  caption.textContent = f.caption;
  caption.className = f.final ? ('final ' + (f.accepted ? 'accepted' : 'rejected')) : '';
  if (tape) {
    tape.innerHTML = f.consumed || f.remaining
      ? '<span class="done">' + escapeHtml(f.consumed) + '</span>' +
        '<span class="todo">' + escapeHtml(f.remaining) + '</span>'
      : '';
  }
  scrub.value = String(i);
  count.textContent = (i + 1) + ' / ' + FRAMES.length;
  document.getElementById('prev').disabled = i === 0;
  document.getElementById('first').disabled = i === 0;
  document.getElementById('next').disabled = i === FRAMES.length - 1;
  document.getElementById('last').disabled = i === FRAMES.length - 1;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
  });
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  playBtn.textContent = 'Play';
}

function play() {
  if (timer) { stop(); return; }
  if (i >= FRAMES.length - 1) show(0);
  playBtn.textContent = 'Pause';
  timer = setInterval(function () {
    if (i >= FRAMES.length - 1) { stop(); return; }
    show(i + 1);
  }, SPEED);
}

document.getElementById('first').onclick = function () { stop(); show(0); };
document.getElementById('prev').onclick = function () { stop(); show(i - 1); };
document.getElementById('next').onclick = function () { stop(); show(i + 1); };
document.getElementById('last').onclick = function () { stop(); show(FRAMES.length - 1); };
playBtn.onclick = play;
scrub.oninput = function () { stop(); show(+scrub.value); };
document.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowRight') { stop(); show(i + 1); }
  else if (e.key === 'ArrowLeft') { stop(); show(i - 1); }
  else if (e.key === ' ') { e.preventDefault(); play(); }
});

show(0);
</script>
</body>
</html>
`;
}

function animate(machine, options = {}) {
  const kind = options.kind || 'trace';
  const anim = kind === 'trace'
    ? traceFrames(machine, options.input != null ? options.input : '')
    : conversionFrames(machine, kind);
  return { anim, html: buildHtml(anim, options) };
}

module.exports = { animate, traceFrames, conversionFrames, buildHtml };
