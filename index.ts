/**
 * omp-vim — Vim-style modal editing for the Oh My Pi (omp) prompt editor.
 *
 * Replaces the composer with a modal `CustomEditor` subclass: an INSERT mode
 * that behaves exactly like the stock editor, and a NORMAL mode with the
 * high-frequency Vim motions and edits. Esc toggles NORMAL; i/a/o/... return to
 * INSERT.
 *
 * Design notes (why this works on omp where upstream-Pi plugins break):
 *  - Factory args are forwarded verbatim to `super(...)`, so omp's `CustomEditor`
 *    captures the `EditorTheme` (by shape) and the `TUI` itself. We never read
 *    host internals.
 *  - omp exposes no public cursor setter, so single-step motions delegate
 *    synthetic key sequences to `super.handleInput(...)` (arrows, word jumps);
 *    line/message motions use the public `moveTo*` helpers for edits.
 *  - omp re-renders the focused editor after every `handleInput`, so mode
 *    changes and edits repaint without touching the renderer.
 *
 * Targets omp (`@oh-my-pi/*`). Not intended for upstream Pi.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey } from "@oh-my-pi/pi-tui";

type Mode = "insert" | "normal";

/** Raw terminal sequences the base `Editor` already understands. */
const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	del: "\x1b[3~", // forward delete (x)
	wordRight: "\x1bf", // alt+f
	wordLeft: "\x1bb", // alt+b
	killWord: "\x1bd", // alt+d (best-effort dw/cw)
	undo: "\x1f", // ctrl+_ (best-effort u)
} as const;

export class VimEditor extends CustomEditor {
	#mode: Mode = "insert";
	/** Pending numeric count prefix in NORMAL mode (e.g. the `5` in `5j`). */
	#count = "";
	/** Pending operator awaiting a second key (`d`, `c`, `g`). */
	#pending: "" | "d" | "c" | "g" = "";

	#setMode(mode: Mode): void {
		if (this.#mode === mode) return;
		this.#mode = mode;
		this.#count = "";
		this.#pending = "";
	}

	/** Repeat `fn` once per numeric-prefix count (default 1, capped for safety). */
	#repeat(fn: () => void): void {
		const n = this.#count ? Math.min(Number.parseInt(this.#count, 10) || 1, 1000) : 1;
		this.#count = "";
		for (let i = 0; i < n; i++) fn();
	}

	override handleInput(data: string): void {
		// INSERT mode: stock behavior, except Esc -> NORMAL (unless completing).
		if (this.#mode === "insert") {
			if (matchesKey(data, "escape") && !this.isShowingAutocomplete()) {
				this.#setMode("normal");
				return;
			}
			super.handleInput(data);
			return;
		}

		// NORMAL mode. Let autocomplete/overlays win if one is open.
		if (this.isShowingAutocomplete()) {
			super.handleInput(data);
			return;
		}
		this.#handleNormal(data);
	}

	#handleNormal(data: string): void {
		// Submit / newline and interrupt stay with the host.
		if (matchesKey(data, "enter") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
			this.#count = "";
			this.#pending = "";
			super.handleInput(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			// Cancel a pending operator/count first; otherwise pass through so the
			// host's Esc (abort stream / clear) still works.
			if (this.#pending || this.#count) {
				this.#pending = "";
				this.#count = "";
				return;
			}
			super.handleInput(data);
			return;
		}

		// Numeric count prefix (a leading 0 is the motion, not a count).
		if (/^[0-9]$/.test(data) && !(data === "0" && this.#count === "")) {
			this.#count += data;
			return;
		}

		// Operator-pending (dd, cc, dw, cw, gg).
		if (this.#pending) {
			this.#resolvePending(data);
			return;
		}

		switch (data) {
			// Motions
			case "h":
				this.#repeat(() => super.handleInput(SEQ.left));
				return;
			case "l":
				this.#repeat(() => super.handleInput(SEQ.right));
				return;
			case "j":
				this.#repeat(() => super.handleInput(SEQ.down));
				return;
			case "k":
				this.#repeat(() => super.handleInput(SEQ.up));
				return;
			case "w":
				this.#repeat(() => super.handleInput(SEQ.wordRight));
				return;
			case "b":
				this.#repeat(() => super.handleInput(SEQ.wordLeft));
				return;
			case "0":
				this.moveToLineStart();
				return;
			case "$":
				this.moveToLineEnd();
				return;
			case "G":
				this.moveToMessageEnd();
				return;

			// Enter INSERT
			case "i":
				this.#setMode("insert");
				return;
			case "a":
				super.handleInput(SEQ.right);
				this.#setMode("insert");
				return;
			case "I":
				this.moveToLineStart();
				this.#setMode("insert");
				return;
			case "A":
				this.moveToLineEnd();
				this.#setMode("insert");
				return;
			case "o":
				this.moveToLineEnd();
				this.insertText("\n");
				this.#setMode("insert");
				return;
			case "O":
				this.moveToLineStart();
				this.insertText("\n");
				super.handleInput(SEQ.up);
				this.#setMode("insert");
				return;

			// Edits
			case "x":
				this.#repeat(() => super.handleInput(SEQ.del));
				return;
			case "D":
				this.#deleteToLineEnd();
				return;
			case "C":
				this.#deleteToLineEnd();
				this.#setMode("insert");
				return;
			case "s":
				super.handleInput(SEQ.del);
				this.#setMode("insert");
				return;
			case "u":
				this.#repeat(() => super.handleInput(SEQ.undo));
				return;

			// Operator / prefix keys
			case "d":
				this.#pending = "d";
				return;
			case "c":
				this.#pending = "c";
				return;
			case "g":
				this.#pending = "g";
				return;

			default:
				// Swallow every other printable key so NORMAL mode never types.
				this.#count = "";
				return;
		}
	}

	#resolvePending(data: string): void {
		const op = this.#pending;
		this.#pending = "";
		if (op === "g") {
			if (data === "g") this.moveToMessageStart();
			return;
		}
		if (op === "d") {
			if (data === "d") this.#deleteLine();
			else if (data === "w") this.#repeat(() => super.handleInput(SEQ.killWord));
			else if (data === "$") this.#deleteToLineEnd();
			return;
		}
		// op === "c"
		if (data === "c") {
			this.#clearLine();
			this.#setMode("insert");
		} else if (data === "w") {
			super.handleInput(SEQ.killWord);
			this.#setMode("insert");
		} else if (data === "$") {
			this.#deleteToLineEnd();
			this.#setMode("insert");
		}
	}

	/** Delete from the cursor to the end of the current line (D / c$ / d$). */
	#deleteToLineEnd(): void {
		const { line, col } = this.getCursor();
		const remaining = (this.getLines()[line]?.length ?? 0) - col;
		if (remaining <= 0) return;
		this.moveToLineEnd();
		this.deleteBeforeCursor(remaining);
	}

	/** Clear the current line's content but keep the (now empty) line (cc). */
	#clearLine(): void {
		const { line } = this.getCursor();
		const len = this.getLines()[line]?.length ?? 0;
		if (len === 0) return;
		this.moveToLineEnd();
		this.deleteBeforeCursor(len);
	}

	/** Delete the whole current line and join to a neighbor (dd). */
	#deleteLine(): void {
		this.#repeat(() => {
			const { line } = this.getCursor();
			const lines = this.getLines();
			const len = lines[line]?.length ?? 0;
			this.moveToLineEnd();
			this.deleteBeforeCursor(len);
			if (line > 0) {
				this.deleteBeforeCursor(1); // eat the newline before this line
			} else if (lines.length > 1) {
				super.handleInput(SEQ.del); // first line: eat the following newline
			}
		});
	}

	override render(width: number): readonly string[] {
		const rows = super.render(width);
		if (this.#mode !== "normal" || width <= 0 || !this.focused) return rows;
		return [...rows, "\x1b[2m-- NORMAL --\x1b[0m"];
	}
}

export default function ompVim(pi: ExtensionAPI): void {
	pi.setLabel("omp-vim");

	let enabled = true;

	const install = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || typeof ctx.ui.setEditorComponent !== "function") return;
		ctx.ui.setEditorComponent(enabled ? (...args: readonly unknown[]) => new VimEditor(...args) : undefined);
		ctx.ui.setStatus("omp-vim", enabled ? "vim" : "vim off");
	};

	pi.on("session_start", (_e, ctx) => install(ctx));
	pi.on("session_switch", (_e, ctx) => install(ctx));
	pi.on("session_branch", (_e, ctx) => install(ctx));
	pi.on("session_tree", (_e, ctx) => install(ctx));

	pi.registerCommand("vim", {
		description: "Toggle omp-vim modal editing (on|off|toggle|status)",
		handler: async (args, ctx) => {
			const action = (args ?? "").trim().toLowerCase() || "toggle";
			if (action === "status") {
				ctx.ui.notify(`omp-vim ${enabled ? "on" : "off"}`, "info");
				return;
			}
			if (action === "on") enabled = true;
			else if (action === "off") enabled = false;
			else if (action === "toggle") enabled = !enabled;
			else {
				ctx.ui.notify("Usage: /vim [on|off|toggle|status]", "warning");
				return;
			}
			install(ctx);
			ctx.ui.notify(`omp-vim ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
