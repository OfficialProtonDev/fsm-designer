# FSM Designer MCP server

Lets Claude work with finite state machines directly: read the diagram a user
is drawing, say what is wrong with it, convert it, and animate the working.

No dependencies. Node 18 or newer, and nothing to install.

```bash
node mcp/test/run.js     # 44 self-checks
```

## Setting it up

Add it to your MCP client's config, pointing at `src/index.js`.

**Claude Code**

```bash
claude mcp add fsm-designer -- node /absolute/path/to/FSM-Designer/mcp/src/index.js
```

**Claude Desktop** — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fsm-designer": {
      "command": "node",
      "args": ["/absolute/path/to/FSM-Designer/mcp/src/index.js"]
    }
  }
}
```

## Working with a user's own diagram

Call `open_designer`. It serves the editor at `http://localhost:4319/` and
keeps it in sync: what the user draws is readable with `get_machine`, and
`set_machine` updates what they see, within about a second.

It has to be *that* URL rather than the published site. A page on `https://…`
cannot call `http://localhost` — browsers block mixed content — so the editor
is served from the same origin as the sync endpoint. The published copy is
untouched by any of this and never loads the sync client.

Sync is last-write-wins. A diagram is one person's working document, and
merging two drawings has no sensible answer.

## Tools

| Tool | What it does |
|---|---|
| `open_designer` | Serve the editor and connect it |
| `get_machine` | Read the current diagram as structured data |
| `set_machine` | Replace the diagram; positions computed automatically |
| `describe_machine` | Alphabet, DFA/NFA/ε-NFA, and everything wrong with it |
| `simulate` | Trace one string, step by step, including where it dies |
| `test_strings` | Check a batch against expected verdicts, with traces for failures |
| `convert` | `nfa_to_dfa`, `remove_epsilon`, `minimize`, `complement`, `reverse` — with steps |
| `compare_machines` | Equivalent? If not, the **shortest** string they disagree on |
| `sample_language` | Shortest strings accepted and rejected |
| `render_svg` | Draw it, in the designer's own style |
| `animate_run` | Animation of a string being read |
| `animate_conversion` | Animation of a conversion being built |
| `save_machine`, `list_machines` | Keep machines by name across sessions |

Every tool that takes a machine will use the open diagram if you do not pass
one, so "is my machine right?" needs no setup beyond `open_designer`.

The current diagram is also exposed as the resource `fsm://current`.

## What it is for

**Understanding a construction without a screenshot.** `get_machine` returns
states, transitions, start and accepting states as data, so Claude reads the
machine rather than guessing at an image.

**Showing a correction rather than describing one.** `set_machine` puts a
fixed machine into the user's editor, still editable.

**Explaining a wrong answer.** `compare_machines` returns the shortest string
two machines disagree on. That single string is usually the whole diagnosis —
trace it and the mistake is visible.

**Teaching the method, not just the result.** `animate_conversion` plays the
subset construction subset by subset, with a caption per step. The output is
one self-contained HTML file with play, step and scrub controls: no network,
no dependencies, openable anywhere.

## Machine format

```json
{
  "name": "ends in 01",
  "states": [
    { "name": "q_0", "start": true },
    { "name": "q_1" },
    { "name": "q_2", "accepting": true }
  ],
  "transitions": [
    { "from": "q_0", "to": "q_0", "on": ["0", "1"] },
    { "from": "q_0", "to": "q_1", "on": "0" },
    { "from": "q_1", "to": "q_2", "on": "1" }
  ]
}
```

State names use the designer's label conventions: `q_0` draws a subscript,
`\alpha` draws α. Transition labels are comma-separated symbol sets, matching
what the editor's help text teaches. An empty move is `"epsilon": true` or a
symbol written `ε`, `\epsilon`, `eps` or `lambda`.

A missing start arrow is reported rather than silently assumed — forgetting it
is a common slip, and inventing one would hide exactly the mistake worth
pointing out. Analysis still runs, from an assumed start.

## Layout

Generated machines are laid out in columns by distance from the start, so
reading left to right follows the machine consuming input. Opposite arrows bow
apart, and an arrow that would otherwise pass through an uninvolved state is
bowed around it.

## A note on the drawing code

`src/render.js` re-implements the designer's geometry rather than importing
`fsm.js`, which is bound to a canvas for its text metrics and to the DOM for
everything else. The shared thing is the *document format*, not the drawing
code, and the constants at the top of `render.js` are kept in step by hand.
Text widths come from a Times metrics table, so a state's width can differ
from the canvas by a pixel or two; the viewer's own font engine draws the text.
