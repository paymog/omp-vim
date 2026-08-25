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
export type FindKind = "f" | "t" | "F" | "T";

type MotionSpec = { linewise: boolean; inclusive: boolean };

const FIND_OPPOSITE: Record<FindKind, FindKind> = { f: "F", F: "f", t: "T", T: "t" };

/** Column the cursor lands on, or null if the motion does not move. */
export function findLanding(line: string, col: number, kind: FindKind, ch: string, count: number): number | null {
	let from = col;
	let idx = -1;
	const forward = kind === "f" || kind === "t";
	for (let i = 0; i < count; i++) {
		if (forward) {
			idx = line.indexOf(ch, from + 1);
		} else {
			if (from <= 0) return null;
			idx = line.lastIndexOf(ch, from - 1);
		}
		if (idx < 0) return null;
		from = idx;
	}
	if (kind === "f" || kind === "F") return idx;
	if (kind === "t") {
		const dest = idx - 1;
		return dest > col ? dest : null;
	}
	const dest = idx + 1;
	return dest < col ? dest : null;
}

type CharKind = "word" | "punct" | "space";

function charKind(ch: string): CharKind {
	if (/\s/.test(ch)) return "space";
	if (/\w/.test(ch)) return "word";
	return "punct";
}

/** Column of the nth word-end, or null if `e` would not move. */
export function wordEnd(line: string, col: number, count: number): number | null {
	let i = col;
	for (let n = 0; n < count; n++) {
		const next = nextWordEnd(line, i);
		if (next === null) return n === 0 ? null : i;
		i = next;
	}
	return i === col ? null : i;
}

function nextWordEnd(line: string, col: number): number | null {
	if (col >= line.length) return null;
	let i = col;
	const t = charKind(line[i] ?? "");
	const atEnd = t !== "space" && (i + 1 >= line.length || charKind(line[i + 1] ?? "") !== t);
	if (atEnd || t === "space") {
		i++;
		while (i < line.length && charKind(line[i] ?? "") === "space") i++;
		if (i >= line.length) return null;
	}
	const wt = charKind(line[i] ?? "");
	while (i + 1 < line.length && charKind(line[i + 1] ?? "") === wt) i++;
	return i;
}

export function firstNonBlank(line: string): number {
	const i = line.search(/\S/);
	return i < 0 ? 0 : i;
}

function isSpace(ch: string): boolean {
	return /\s/.test(ch);
}

/** Start of the next whitespace-delimited WORD, or null. */
export function bigWordStartForward(line: string, col: number): number | null {
	let i = col;
	if (i >= line.length) return null;
	if (!isSpace(line[i] ?? "")) {
		while (i < line.length && !isSpace(line[i] ?? "")) i++;
	}
	while (i < line.length && isSpace(line[i] ?? "")) i++;
	return i < line.length ? i : null;
}

/** Start of the previous whitespace-delimited WORD, or null. */
export function bigWordStartBack(line: string, col: number): number | null {
	if (col <= 0) return null;
	let i = col - 1;
	while (i >= 0 && isSpace(line[i] ?? "")) i--;
	if (i < 0) return null;
	while (i > 0 && !isSpace(line[i - 1] ?? "")) i--;
	return i;
}

/** Column of the nth WORD-end, or null if `E` would not move. */
export function bigWordEnd(line: string, col: number, count: number): number | null {
	let i = col;
	for (let n = 0; n < count; n++) {
		const next = nextBigWordEnd(line, i);
		if (next === null) return n === 0 ? null : i;
		i = next;
	}
	return i === col ? null : i;
}

function nextBigWordEnd(line: string, col: number): number | null {
	if (col >= line.length) return null;
	let i = col;
	const atEnd = !isSpace(line[i] ?? "") && (i + 1 >= line.length || isSpace(line[i + 1] ?? ""));
	if (atEnd || isSpace(line[i] ?? "")) {
		i++;
		while (i < line.length && isSpace(line[i] ?? "")) i++;
		if (i >= line.length) return null;
	}
	while (i + 1 < line.length && !isSpace(line[i + 1] ?? "")) i++;
	return i;
}

/** Same-line delete: move to `end`, then `deleteBeforeCursor(n)`. */
export function charwiseSpan(a: number, b: number, inclusive: boolean): { end: number; n: number } | null {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	const n = inclusive ? hi - lo + 1 : hi - lo;
	if (n <= 0) return null;
	return { end: inclusive ? hi + 1 : hi, n };
}

export function motionSpec(data: string): MotionSpec | null {
	switch (data) {
		case "h":
		case "l":
		case "w":
		case "b":
		case "0":
		case "W":
		case "B":
		case "^":
			return { linewise: false, inclusive: false };
		case "e":
		case "E":
		case ";":
		case ",":
			return { linewise: false, inclusive: true };
		case "$":
			// Editor `$` lands past the last char, so exclusive [col, length) is d$.
			return { linewise: false, inclusive: false };
		case "j":
		case "k":
		case "G":
			return { linewise: true, inclusive: false };
		default:
			return null;
	}
}

/** Raw terminal sequences the base `Editor` already understands. */
const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	del: "\x1b[3~", // forward delete (x)
	backspace: "\x7f",
	wordRight: "\x1bf", // alt+f
	wordLeft: "\x1bb", // alt+b
	undo: "\x1f", // ctrl+_ (best-effort u)
} as const;

export class VimEditor extends CustomEditor {
	#mode: Mode = "insert";
	/** Pending numeric count prefix in NORMAL mode (e.g. the `5` in `5j`). */
	#count = "";
	/** Pending operator (`d`/`c`) awaiting a motion. */
	#op: "" | "d" | "c" = "";
	/** Second key still needed (`g` or a find motion). */
	#await: "" | "g" | FindKind = "";
	#lastFind: { kind: FindKind; ch: string } | null = null;

	#setMode(mode: Mode): void {
		if (this.#mode === mode) return;
		this.#mode = mode;
		this.#count = "";
		this.#op = "";
		this.#await = "";
	}

	#takeCount(): number {
		const n = this.#count ? Math.min(Number.parseInt(this.#count, 10) || 1, 1000) : 1;
		this.#count = "";
		return n;
	}

	/** Repeat `fn` once per numeric-prefix count (default 1, capped for safety). */
	#repeat(fn: () => void): void {
		const n = this.#takeCount();
		for (let i = 0; i < n; i++) fn();
	}

	#clearPending(): void {
		this.#op = "";
		this.#await = "";
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
			this.#clearPending();
			super.handleInput(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			// Cancel a pending operator/count first; otherwise pass through so the
			// host's Esc (abort stream / clear) still works.
			if (this.#op || this.#await || this.#count) {
				this.#count = "";
				this.#clearPending();
				return;
			}
			super.handleInput(data);
			return;
		}

		if (this.#await) {
			this.#resolveAwait(data);
			return;
		}

		// Numeric count prefix (a leading 0 is the motion, not a count).
		if (/^[0-9]$/.test(data) && !(data === "0" && this.#count === "")) {
			this.#count += data;
			return;
		}

		if (this.#op) {
			this.#resolveOp(data);
			return;
		}

		switch (data) {
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
			case "d":
				this.#op = "d";
				return;
			case "c":
				this.#op = "c";
				return;
			case "g":
				this.#await = "g";
				return;
			case "f":
			case "t":
			case "F":
			case "T":
				this.#await = data;
				return;
			default:
				if (this.#doMotion(data)) return;
				this.#count = "";
		}
	}

	#resolveAwait(data: string): void {
		const kind = this.#await;
		this.#await = "";
		if (kind === "g") {
			if (data !== "g") return;
			if (this.#op) this.#operate({ linewise: true, inclusive: false }, () => this.moveToMessageStart());
			else this.moveToMessageStart();
			return;
		}
		if (!kind || data.length !== 1) return;
		if (this.#op) this.#operate({ linewise: false, inclusive: true }, () => this.#applyFind(kind, data));
		else this.#applyFind(kind, data);
	}

	#resolveOp(data: string): void {
		if (data === this.#op) {
			this.#op = "";
			if (data === "d") this.#deleteLine();
			else {
				this.#clearLine();
				this.#setMode("insert");
			}
			return;
		}
		if (data === "f" || data === "t" || data === "F" || data === "T") {
			this.#await = data;
			return;
		}
		if (data === "g") {
			this.#await = "g";
			return;
		}
		// vim: cw == ce
		const key = this.#op === "c" && data === "w" ? "e" : data;
		const spec = motionSpec(key);
		if (!spec) {
			this.#op = "";
			return;
		}
		this.#operate(spec, () => {
			this.#doMotion(key);
		});
	}

	#operate(spec: MotionSpec, move: () => void): void {
		const start = this.getCursor();
		move();
		const end = this.getCursor();
		const op = this.#op;
		this.#clearPending();
		if (spec.linewise) {
			this.#deleteLines(start.line, end.line);
			if (op === "c") this.#setMode("insert");
			return;
		}
		if (start.line === end.line && start.col === end.col) return;
		this.#deleteCharwise(start, end, spec.inclusive);
		if (op === "c") this.#setMode("insert");
	}

	#doMotion(data: string): boolean {
		switch (data) {
			case "h":
				this.#repeat(() => super.handleInput(SEQ.left));
				return true;
			case "l":
				this.#repeat(() => super.handleInput(SEQ.right));
				return true;
			case "j":
				this.#repeat(() => super.handleInput(SEQ.down));
				return true;
			case "k":
				this.#repeat(() => super.handleInput(SEQ.up));
				return true;
			case "w":
				this.#repeat(() => super.handleInput(SEQ.wordRight));
				return true;
			case "b":
				this.#repeat(() => super.handleInput(SEQ.wordLeft));
				return true;
			case "e": {
				const n = this.#takeCount();
				const { line, col } = this.getCursor();
				const dest = wordEnd(this.getLines()[line] ?? "", col, n);
				if (dest !== null) this.#moveToCol(dest);
				return true;
			}
			case "W":
				this.#repeat(() => this.#stepW());
				return true;
			case "B":
				this.#repeat(() => this.#stepB());
				return true;
			case "E": {
				const n = this.#takeCount();
				for (let i = 0; i < n; i++) this.#stepE();
				return true;
			}
			case "^": {
				const { line, col } = this.getCursor();
				const dest = firstNonBlank(this.getLines()[line] ?? "");
				if (dest !== col) this.#moveToCol(dest);
				return true;
			}
			case "0":
				this.moveToLineStart();
				return true;
			case "$":
				this.moveToLineEnd();
				return true;
			case "G":
				this.moveToMessageEnd();
				return true;
			case ";":
				this.#replayFind(false);
				return true;
			case ",":
				this.#replayFind(true);
				return true;
			default:
				return false;
		}
	}

	#replayFind(reverse: boolean): void {
		if (!this.#lastFind) {
			this.#clearPending();
			return;
		}
		const kind = reverse ? FIND_OPPOSITE[this.#lastFind.kind] : this.#lastFind.kind;
		this.#applyFind(kind, this.#lastFind.ch, false);
	}

	#applyFind(kind: FindKind, ch: string, remember = true): void {
		const { line, col } = this.getCursor();
		const dest = findLanding(this.getLines()[line] ?? "", col, kind, ch, this.#takeCount());
		if (remember) this.#lastFind = { kind, ch };
		if (dest === null) return;
		this.#moveToCol(dest);
	}

	#moveToCol(col: number): void {
		const cur = this.getCursor().col;
		const seq = col > cur ? SEQ.right : SEQ.left;
		for (let i = 0; i < Math.abs(col - cur); i++) super.handleInput(seq);
	}

	#goToLine(line: number): void {
		const cur = this.getCursor().line;
		const seq = line > cur ? SEQ.down : SEQ.up;
		for (let i = 0; i < Math.abs(line - cur); i++) super.handleInput(seq);
	}

	#stepW(): void {
		const { line, col } = this.getCursor();
		const lines = this.getLines();
		const dest = bigWordStartForward(lines[line] ?? "", col);
		if (dest !== null) {
			this.#moveToCol(dest);
			return;
		}
		if (line + 1 >= lines.length) return;
		this.#goToLine(line + 1);
		this.moveToLineStart();
		this.#moveToCol(firstNonBlank(lines[line + 1] ?? ""));
	}

	#stepB(): void {
		const { line, col } = this.getCursor();
		const lines = this.getLines();
		const dest = bigWordStartBack(lines[line] ?? "", col);
		if (dest !== null) {
			this.#moveToCol(dest);
			return;
		}
		if (line <= 0) return;
		const prev = lines[line - 1] ?? "";
		this.#goToLine(line - 1);
		this.moveToLineStart();
		this.#moveToCol(bigWordStartBack(prev, prev.length) ?? 0);
	}

	#stepE(): void {
		const { line, col } = this.getCursor();
		const lines = this.getLines();
		const dest = bigWordEnd(lines[line] ?? "", col, 1);
		if (dest !== null) {
			this.#moveToCol(dest);
			return;
		}
		if (line + 1 >= lines.length) return;
		const next = lines[line + 1] ?? "";
		this.#goToLine(line + 1);
		this.moveToLineStart();
		const end = bigWordEnd(next, 0, 1);
		if (end !== null) this.#moveToCol(end);
	}

	#deleteCharwise(start: { line: number; col: number }, end: { line: number; col: number }, inclusive: boolean): void {
		if (start.line === end.line) {
			const span = charwiseSpan(start.col, end.col, inclusive);
			if (!span) return;
			this.#moveToCol(span.end);
			this.deleteBeforeCursor(span.n);
			return;
		}
		// ponytail: no range-delete API; each backspace is its own undo
		const a = start.line < end.line || (start.line === end.line && start.col <= end.col) ? start : end;
		const b = a === start ? end : start;
		this.#goToLine(b.line);
		this.#moveToCol(inclusive ? b.col + 1 : b.col);
		for (let i = 0; i < 10000; i++) {
			const c = this.getCursor();
			if (c.line < a.line || (c.line === a.line && c.col <= a.col)) return;
			if (c.col > 0) this.deleteBeforeCursor(c.line === a.line ? c.col - a.col : c.col);
			else super.handleInput(SEQ.backspace);
		}
	}

	#deleteLines(from: number, to: number): void {
		const lo = Math.min(from, to);
		const hi = Math.max(from, to);
		this.#goToLine(hi);
		for (let i = 0; i < hi - lo + 1; i++) this.#deleteOneLine();
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
		this.#repeat(() => this.#deleteOneLine());
	}

	#deleteOneLine(): void {
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
		ctx.ui.setStatus("omp-vim", undefined);
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
