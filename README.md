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

## Layout

- `index.html` — page shell, toolbar, help text
- `style.css` — styling
- `fsm.js` — the whole editor: geometry, interaction, and the PNG/SVG/TikZ
  exporters, which all share one canvas-like drawing interface
