# omp-vim

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

Then restart the session. The status line shows `vim`, and a `-- NORMAL --`
indicator appears below the editor whenever you are in normal mode.

To remove:

```sh
omp plugin uninstall omp-vim
```

## Usage

Start typing as usual (INSERT). Press `Esc` to enter NORMAL mode.

| Key | Mode | Action |
| --- | ---- | ------ |
| `Esc` | insert | Enter NORMAL mode (passes through if autocomplete is open) |
| `Esc` | normal | Clear a pending count/operator, else pass through (abort / clear) |
| `Enter` | normal | Submit / newline (delegated to omp) |
| `h` `j` `k` `l` | normal | Move left / down / up / right |
| `w` `b` | normal | Word forward / back |
| `0` `$` | normal | Start / end of line |
| `gg` `G` | normal | Start / end of the prompt |
| `i` `a` | normal | Insert before / after the cursor |
| `I` `A` | normal | Insert at line start / end |
| `o` `O` | normal | Open a line below / above |
| `x` | normal | Delete character under the cursor |
| `s` | normal | Delete character and insert |
| `dd` | normal | Delete the current line |
| `dw` | normal | Delete word forward |
| `d$` `D` | normal | Delete to end of line |
| `cc` | normal | Change the current line |
| `cw` | normal | Change word forward |
| `c$` `C` | normal | Change to end of line |
| `u` | normal | Undo |
| `5j`, `3w`, … | normal | Numeric count prefix repeats the motion/edit |

`Ctrl+C` / `Ctrl+D` always pass through to `omp` (clear / exit).

### Toggle at runtime

```
/vim            # toggle on/off
/vim on
/vim off
/vim status
```

## Scope

This is a pragmatic subset aimed at prompt editing, not full Vim parity. Motions
that `omp`'s editor has no public cursor setter for are implemented by
delegating the editor's own key handling (arrow keys, word jumps), so behavior
matches the stock editor's cursor semantics. Visual mode, registers, macros, and
search are intentionally out of scope for now.

## How it works

`omp`'s `ExtensionUIContext.setEditorComponent(factory)` lets an extension swap
the composer. `omp-vim` supplies a `CustomEditor` subclass:

- The factory forwards its args verbatim to `super(...)`, so `omp` captures the
  `EditorTheme` (and `TUI`) itself — avoiding the constructor-shape mismatch that
  breaks upstream-Pi editor plugins on `omp`.
- NORMAL-mode motions delegate synthetic key sequences (arrows, `alt+f`/`alt+b`)
  to the base editor, and use the public `moveToLine*` / `moveToMessage*` /
  `insertText` / `deleteBeforeCursor` helpers for edits.
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
