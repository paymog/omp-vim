# omp-vim

[![omp status](https://omppackages.com/badge/omp-vim.svg)](https://omppackages.com/packages/omp-vim)

Vim-style modal editing for the [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) prompt editor.

`omp-vim` replaces the composer with a modal editor: an **INSERT** mode that
behaves exactly like the stock prompt, and a **NORMAL** mode with the
high-frequency Vim motions and edits. It targets `omp` specifically and works on
the shipped `CustomEditor` API — no private-field access, so it does not break
the way upstream-Pi vim plugins do on `omp`.

## Install

```sh
omp plugin install omp-vim
```

Then restart the session. A `-- NORMAL --` / `-- VISUAL --` / `-- VISUAL LINE --`
indicator appears below the editor outside insert mode.

To remove:

```sh
omp plugin uninstall omp-vim
```

## Usage

Start typing as usual (INSERT). Press `Esc` to enter NORMAL mode.

| Key | Mode | Action |
| --- | ---- | ------ |
| `Esc` | insert | Enter NORMAL mode (passes through if autocomplete is open) |
| `Esc` | normal | First press clears a count/operator or starts a 500 ms interrupt window; second press aborts |
| `Enter` | normal | Submit / newline (delegated to omp) |
| `h` `j` `k` `l` | normal | Move left / down / up / right |
| `w` `b` `e` | normal | Word forward / back / end (wraps across lines) |
| `W` `B` `E` | normal | WORD forward / back / end (whitespace-delimited) |
| `0` `^` `$` | normal | Start / first non-blank / end of line |
| `gg` `G` | normal | First / last line (`5G`, `5gg` go to line 5) |
| `f` `t` `F` `T` | normal | Find char on the line (to / till, forward / back) |
| `;` `,` | normal | Repeat last find / reverse it |
| `i` `a` | normal | Insert before / after the cursor |
| `I` `A` | normal | Insert at first non-blank / line end |
| `o` `O` | normal | Open a line below / above |
| `x` `X` | normal | Delete character under / before the cursor |
| `r{char}` | normal | Replace character(s) under the cursor (`3rx`) |
| `~` | normal | Toggle case and advance |
| `s` `S` | normal | Substitute character / line |
| `J` | normal | Join lines |
| `d{motion}` `c{motion}` `y{motion}` | normal | Delete / change / yank over any motion (`dw` `de` `d$` `dG` `df.` `d3j` …) |
| `dd` `cc` `yy` | normal | Delete / change / yank the current line(s) |
| `D` `C` `Y` | normal | Delete / change to end of line; yank line |
| `iw` `aw` `iW` `aW` | operator, visual | Word text objects (`diw`, `caw`, `viw`) |
| `i"` `a"` `i'` `` i` `` | operator, visual | Quote text objects on the line |
| `i(` `a(` `ib` `i[` `i{` `iB` `i<` | operator, visual | Bracket text objects (nesting and multi-line aware) |
| `p` `P` | normal | Put the unnamed register after / before (`xp`, `ddp`) |
| `v` `V` | normal | Visual / visual-line mode; `o` swaps ends; `d` `x` `c` `s` `y` act on the selection |
| `u` | normal | Undo the whole last change |
| `.` | normal | Repeat the last change |
| `5j`, `3f.`, … | normal | Numeric count prefix repeats the motion/edit |

`Ctrl+C` / `Ctrl+D` always pass through to `omp` (clear / exit).

### Toggle at runtime

```
/vim            # toggle on/off
/vim on
/vim off
/vim status
```

## Scope

This is a pragmatic subset aimed at prompt editing, not full Vim parity. `omp`'s
editor has no public cursor setter, so the cursor moves by synthetic arrow keys.
`j` / `k` follow wrapped rows (like `gj` / `gk`); operators such as `dj` use
logical lines.

Not implemented:

- Redo (`Ctrl+R`). The base editor has no redo stack.
- A highlighted visual selection. The editor exposes no selection rendering, so
  visual mode shows only the mode indicator and the cursor.
- Named registers, system-clipboard sync, search (`/`, `?`, `n`), macros, marks,
  `:` commands, and `%`.

## How it works

`omp`'s `ExtensionUIContext.setEditorComponent(factory)` lets an extension swap
the composer. `omp-vim` supplies a `CustomEditor` subclass:

- The factory forwards its args verbatim to `super(...)`, so `omp` captures the
  `EditorTheme` (and `TUI`) itself — avoiding the constructor-shape mismatch that
  breaks upstream-Pi editor plugins on `omp`.
- NORMAL-mode motions send synthetic arrow keys to the base editor and use the
  public `moveToLine*` / `insertText` / `deleteBeforeCursor` helpers for edits.
  `u` replays base-editor undo steps until the text matches its state before the
  last Vim change.
- `omp` re-renders the focused editor after every keystroke, so mode changes and
  edits repaint with no direct renderer calls.

## Development

```sh
bun install
bun run check   # tsc --noEmit against the @oh-my-pi types
```

Load a local checkout without publishing:

```sh
omp plugin link /path/to/omp-vim
```

## License

MIT
