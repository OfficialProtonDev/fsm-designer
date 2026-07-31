# Finite State Machine Designer

A browser-based editor for drawing finite state machines on an HTML5 canvas,
inspired by the classic FSM designer by Evan Wallace. This is an independent
rewrite with a few things the original didn't do.

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
| Delete something | click it, press <kbd>Delete</kbd> |
| Make accept state | double-click an existing state |
| Rename | click a state or arrow and type |
| Pan | drag empty canvas, or alt-drag / middle-drag |
| Zoom | scroll wheel, toolbar buttons, or <kbd>Ctrl</kbd>+<kbd>+</kbd>/<kbd>-</kbd> |

Type `S_0` for a numeric subscript and `\beta` for a greek letter.

Diagrams are saved to `localStorage` automatically, and export to PNG, SVG, or
LaTeX (TikZ).

## Running it

It's three static files with no build step and no dependencies:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Layout

- `index.html` — page shell, toolbar, help text
- `style.css` — styling
- `fsm.js` — the whole editor: geometry, interaction, and the PNG/SVG/TikZ
  exporters, which all share one canvas-like drawing interface
