# Finite State Machine Designer

A browser-based editor for drawing finite state machines on an HTML5 canvas.

## Credit

This owes its concept and interaction design to the
[Finite State Machine Designer](https://madebyevan.com/fsm/) created by
[Evan Wallace](https://madebyevan.com/) in 2010. This is an independent rewrite
rather than a fork — none of the original code is used — and it adds a few
things the original didn't do.

## What's different

- **States stretch into pill shapes.** A state is a stadium: a straight
  section capped by two semicircles. Short names leave the straight section at
  zero length, so they still draw as plain circles; long names widen the state
  instead of spilling over its edge. Arrows are trimmed against the real
  outline by bisection, so they meet pills and circles equally cleanly.
- **Clear All button**, with a confirmation prompt.
- **Unbounded, pannable, zoomable canvas** rather than a fixed 800×600 box.

## How to use

| Action | Gesture |
| --- | --- |
| Add a state | double-click on the canvas |
| Add an arrow | shift-drag on the canvas |
| Move something | drag it around |
| Select several states | right-drag a box around them (<kbd>Shift</kbd> to add) |
| Move a selection | drag any highlighted state |
| Edit mid-label | click into the label; <kbd>←</kbd> <kbd>→</kbd> <kbd>Home</kbd> <kbd>End</kbd> |
| Highlight label text | drag across an arrow's label, <kbd>Shift</kbd>+arrows, or <kbd>Ctrl</kbd>+<kbd>A</kbd> |
| Copy / cut / paste | <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>X</kbd> / <kbd>V</kbd> |
| Delete something | click it, press <kbd>Delete</kbd> |
| Make accept state | double-click an existing state |
| Rename | click a state or arrow and type |
| Pan | drag empty canvas, or alt-drag / middle-drag |
| Zoom | scroll wheel, toolbar buttons, or <kbd>Ctrl</kbd>+<kbd>+</kbd>/<kbd>-</kbd> |

Type `\beta` for a greek letter, and an underscore for a subscript: `S_0` or
`q_a` take the next character, `q_{start}` takes a braced run. Subscripts are
drawn rather than swapped for Unicode subscript glyphs, so any character works
— Unicode has no subscript `b`, `d`, `q`, `y`, `z` or capitals at all.

There are two clipboards — states and label text — and one <kbd>Ctrl</kbd>+<kbd>V</kbd>,
so whichever you copied last is what a paste means. Pasting text into an object
selected by its line, rather than by clicking its text, appends at the end of
the label.

Copying takes the selected states, and any transition whose *both* ends are in
the selection. Repeated pastes cascade rather than stacking on one spot. The
clipboard lives in the page, so it doesn't carry between browser tabs.

Diagrams are saved to `localStorage` automatically, and export to PNG, SVG, or
LaTeX (TikZ).

## Running it

It's three static files with no build step and no dependencies:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Using it with Claude

[`mcp/`](mcp/) is an MCP server that lets Claude work with these machines
directly — read the diagram you are drawing, tell you what is wrong with it,
convert it, and animate the working. It has no dependencies.

```bash
claude mcp add fsm-designer -- node "$PWD/mcp/src/index.js"
```

Ask Claude to open the designer and it serves this editor at
`http://localhost:4319/`, synced both ways: what you draw it can read, and
what it fixes appears in your editor. It can check your machine against a
description, hand back the shortest string that proves two machines differ,
and produce a self-contained animation of a subset construction or of a string
being read. See [mcp/README.md](mcp/README.md).

The published site is unaffected and never loads any of it.

## Layout

- `index.html` — page shell, toolbar, help text
- `style.css` — styling
- `fsm.js` — the whole editor: geometry, interaction, and the PNG/SVG/TikZ
  exporters, which all share one canvas-like drawing interface
- `bridge-client.js` — syncs with the MCP server; only loaded when that
  server is serving the page
- `mcp/` — the MCP server
