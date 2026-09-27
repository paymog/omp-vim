/**
 * omp-vim — Vim-style modal editing for the Oh My Pi (omp) prompt editor.
 *
 * Replaces the composer with a modal `CustomEditor` subclass: an INSERT mode
 * that behaves exactly like the stock editor, and NORMAL / VISUAL modes with
 * the high-frequency Vim motions, operators, text objects, and registers.
 *
 * Design notes (why this works on omp where upstream-Pi plugins break):
 *  - Factory args are forwarded verbatim to `super(...)`, so omp's `CustomEditor`
 *    captures the `EditorTheme` (by shape) and the `TUI` itself. We never read
 *    host internals.
 *  - omp exposes no public cursor setter, so the cursor moves by synthetic arrow
 *    keys sent to `super.handleInput(...)`. Edits use the public
 *    `insertText` / `deleteBeforeCursor` helpers.
 *  - omp re-renders the focused editor after every `handleInput`, so mode
 *    changes and edits repaint without touching the renderer.
 *
 * Targets omp (`@oh-my-pi/*`). Not intended for upstream Pi.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey } from "@oh-my-pi/pi-tui";

type Mode = "insert" | "normal";
type Op = "d" | "c" | "y";
export type FindKind = "f" | "t" | "F" | "T";
export type Pos = { line: number; col: number };
export type Range = { start: Pos; end: Pos };

type MotionSpec = { linewise: boolean; inclusive: boolean };
/** A multi-key NORMAL command, tracked for grouped undo and `.` repeat. */
type Change = { before: string; keys: string[]; undo: boolean; dot: boolean };

const FIND_OPPOSITE: Record<FindKind, FindKind> = { f: "F", F: "f", t: "T", T: "t" };
const LINEWISE: MotionSpec = { linewise: true, inclusive: false };
const EXCLUSIVE: MotionSpec = { linewise: false, inclusive: false };

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

function isSpace(ch: string): boolean {
	return /\s/.test(ch);
}

/** `big` is Vim's WORD: any run of non-blanks. */
function charKind(ch: string, big: boolean): CharKind {
	if (isSpace(ch)) return "space";
	if (big || /\w/.test(ch)) return "word";
	return "punct";
}

function kindAt(line: string, i: number, big: boolean): CharKind {
	return charKind(line[i] ?? " ", big);
}

/** Start of the next word on the line (`w` / `W`), or null. */
export function wordStartForward(line: string, col: number, big: boolean): number | null {
	if (col >= line.length) return null;
	let i = col;
	const k = kindAt(line, i, big);
	if (k !== "space") while (i < line.length && kindAt(line, i, big) === k) i++;
	while (i < line.length && kindAt(line, i, big) === "space") i++;
	return i < line.length ? i : null;
}

/** Start of the previous word on the line (`b` / `B`), or null. */
export function wordStartBack(line: string, col: number, big: boolean): number | null {
	let i = Math.min(col, line.length) - 1;
	while (i >= 0 && kindAt(line, i, big) === "space") i--;
	if (i < 0) return null;
	const k = kindAt(line, i, big);
	while (i > 0 && kindAt(line, i - 1, big) === k) i--;
	return i;
}

/** Next word end on the line (`e` / `E`), or null. `col` may be -1 to search from the line start. */
export function wordEndForward(line: string, col: number, big: boolean): number | null {
	let i = col + 1;
	while (i < line.length && kindAt(line, i, big) === "space") i++;
	if (i >= line.length) return null;
	const k = kindAt(line, i, big);
	while (i + 1 < line.length && kindAt(line, i + 1, big) === k) i++;
	return i;
}

export function firstNonBlank(line: string): number {
	const i = line.search(/\S/);
	return i < 0 ? 0 : i;
}

function order(a: Pos, b: Pos): [Pos, Pos] {
	return a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a];
}

function toOffset(lines: readonly string[], pos: Pos): number {
	let off = pos.col;
	for (let i = 0; i < pos.line; i++) off += (lines[i] ?? "").length + 1;
	return off;
}

function toPos(lines: readonly string[], offset: number): Pos {
	let off = offset;
	for (let line = 0; line < lines.length; line++) {
		const len = (lines[line] ?? "").length;
		if (off <= len) return { line, col: off };
		off -= len + 1;
	}
	const last = Math.max(lines.length - 1, 0);
	return { line: last, col: (lines[last] ?? "").length };
}

/** Text in `[a, b)`. */
function sliceRange(lines: readonly string[], a: Pos, b: Pos): string {
	if (a.line === b.line) return (lines[a.line] ?? "").slice(a.col, b.col);
	return [
		(lines[a.line] ?? "").slice(a.col),
		...lines.slice(a.line + 1, b.line),
		(lines[b.line] ?? "").slice(0, b.col),
	].join("\n");
}

function wordObject(line: string, col: number, big: boolean, around: boolean): [number, number] | null {
	if (line.length === 0) return null;
	const i = Math.min(col, line.length - 1);
	const k = kindAt(line, i, big);
	let s = i;
	while (s > 0 && kindAt(line, s - 1, big) === k) s--;
	let e = i + 1;
	while (e < line.length && kindAt(line, e, big) === k) e++;
	if (!around) return [s, e];
	if (k === "space") {
		const next = kindAt(line, e, big);
		while (e < line.length && kindAt(line, e, big) === next) e++;
		return [s, e];
	}
	let t = e;
	while (t < line.length && isSpace(line[t] ?? "")) t++;
	if (t > e) return [s, t];
	while (s > 0 && isSpace(line[s - 1] ?? "")) s--;
	return [s, e];
}

function quoteObject(line: string, col: number, quote: string, around: boolean): [number, number] | null {
	const idx: number[] = [];
	for (let i = 0; i < line.length; i++) if (line[i] === quote && line[i - 1] !== "\\") idx.push(i);
	for (let p = 0; p + 1 < idx.length; p += 2) {
		const open = idx[p] ?? 0;
		const close = idx[p + 1] ?? 0;
		if (col <= close) return around ? [open, close + 1] : [open + 1, close];
	}
	return null;
}

function bracketObject(text: string, off: number, open: string, close: string, around: boolean): [number, number] | null {
	let depth = 0;
	let o = -1;
	for (let j = Math.min(off, text.length - 1); j >= 0; j--) {
		const c = text[j];
		if (c === close && j !== off) depth++;
		else if (c === open) {
			if (depth === 0) {
				o = j;
				break;
			}
			depth--;
		}
	}
	if (o < 0) return null;
	depth = 0;
	for (let j = o + 1; j < text.length; j++) {
		const c = text[j];
		if (c === open) depth++;
		else if (c === close) {
			if (depth === 0) return around ? [o, j + 1] : [o + 1, j];
			depth--;
		}
	}
	return null;
}

const BRACKETS: Record<string, [string, string]> = {
	"(": ["(", ")"],
	")": ["(", ")"],
	b: ["(", ")"],
	"[": ["[", "]"],
	"]": ["[", "]"],
	"{": ["{", "}"],
	"}": ["{", "}"],
	B: ["{", "}"],
	"<": ["<", ">"],
	">": ["<", ">"],
};

/** Range (end exclusive) of text object `i{obj}` / `a{obj}` at `pos`, or null. */
export function textObject(lines: readonly string[], pos: Pos, obj: string, around: boolean): Range | null {
	const line = lines[pos.line] ?? "";
	let span: [number, number] | null = null;
	if (obj === "w" || obj === "W") span = wordObject(line, pos.col, obj === "W", around);
	else if (obj === '"' || obj === "'" || obj === "`") span = quoteObject(line, pos.col, obj, around);
	else {
		const pair = BRACKETS[obj];
		if (!pair) return null;
		const r = bracketObject(lines.join("\n"), toOffset(lines, pos), pair[0], pair[1], around);
		return r && { start: toPos(lines, r[0]), end: toPos(lines, r[1]) };
	}
	return span && { start: { line: pos.line, col: span[0] }, end: { line: pos.line, col: span[1] } };
}

function motionSpec(data: string): MotionSpec | null {
	switch (data) {
		case "h":
		case "l":
		case "w":
		case "b":
		case "0":
		case "W":
		case "B":
		case "^":
		case "$": // `$` lands past the last char, so exclusive [col, length) is d$.
			return EXCLUSIVE;
		case "e":
		case "E":
			return { linewise: false, inclusive: true };
		case "G":
			return LINEWISE;
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
	backspace: "\x7f",
	undo: "\x1f", // ctrl+_
} as const;

export class VimEditor extends CustomEditor {
	#mode: Mode = "insert";
	/** Pending numeric count prefix in NORMAL mode (e.g. the `5` in `5j`). */
	#count = "";
	/** Pending operator awaiting a motion or text object. */
	#op: "" | Op = "";
	/** Second key still needed: `gg`, `r{char}`, `i{obj}` / `a{obj}`, or a find char. */
	#await: "" | "g" | "r" | "i" | "a" | FindKind = "";
	#lastFind: { kind: FindKind; ch: string } | null = null;
	#visual: { anchor: Pos; linewise: boolean } | null = null;
	/** Unnamed register shared by d/c/y/x and p/P. */
	#register: { text: string; linewise: boolean } | null = null;
	#change: Change | null = null;
	#lastChange: string[] = [];
	#replaying = false;
	/** One entry per Vim change, so `u` undoes the whole change, not one base-editor step. */
	#undo: Array<{ before: string; after: string }> = [];
	/** Timestamp of the first Esc in a NORMAL-mode interrupt gesture. */
	#normalEscapeAt = 0;

	#setMode(mode: Mode): void {
		if (this.#mode === mode) return;
		this.#mode = mode;
		this.#count = "";
		this.#clearPending();
		this.#visual = null;
		this.#normalEscapeAt = 0;
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

	#line(line = this.getCursor().line): string {
		return this.getLines()[line] ?? "";
	}

	override handleInput(data: string): void {
		// A terminal can batch a double-Esc gesture into one input packet.
		if (data === "\x1b\x1b") {
			this.handleInput("\x1b");
			this.handleInput("\x1b");
			return;
		}
		if (this.#replaying) {
			this.#dispatch(data);
			return;
		}
		if (!this.#change) this.#change = { before: this.getText(), keys: [], undo: true, dot: this.#mode === "normal" };
		this.#change.keys.push(data);
		this.#dispatch(data);
		if (this.#mode === "normal" && !this.#op && !this.#await && !this.#count && !this.#visual) this.#finishChange();
	}

	#dispatch(data: string): void {
		// INSERT mode: stock behavior, except Esc -> NORMAL (unless completing).
		if (this.#mode === "insert") {
			if (matchesKey(data, "escape") && !this.isShowingAutocomplete()) {
				this.#setMode("normal");
				const { col } = this.getCursor();
				if (col > 0) this.#moveToCol(col - 1);
				return;
			}
			super.handleInput(data);
			// Submitting ends the change; it must never be replayed by `.`.
			if (matchesKey(data, "enter")) this.#change = null;
			return;
		}

		// NORMAL mode. Let autocomplete/overlays win if one is open.
		if (this.isShowingAutocomplete()) {
			super.handleInput(data);
			return;
		}
		const count = this.#count;
		this.#handleNormal(data);
		if (this.#count === count && !this.#op && !this.#await) this.#count = "";
		if (this.#mode === "normal") this.#clampCursor();
	}

	#finishChange(): void {
		const change = this.#change;
		this.#change = null;
		if (!change?.undo) return;
		const after = this.getText();
		if (after === change.before) return;
		this.#undo.push({ before: change.before, after });
		if (this.#undo.length > 100) this.#undo.shift();
		if (change.dot) this.#lastChange = change.keys;
	}

	#noRecord(): void {
		if (!this.#change) return;
		this.#change.undo = false;
		this.#change.dot = false;
	}

	#handleNormal(data: string): void {
		const escape = matchesKey(data, "escape");
		if (!escape) this.#normalEscapeAt = 0;

		// Submit / newline and interrupt stay with the host.
		if (matchesKey(data, "enter") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
			this.#noRecord();
			this.#count = "";
			this.#clearPending();
			this.#visual = null;
			super.handleInput(data);
			return;
		}
		if (escape) {
			if (this.#visual) {
				this.#visual = null;
				this.#count = "";
				this.#clearPending();
				return;
			}
			if (this.#op || this.#await || this.#count) {
				this.#count = "";
				this.#clearPending();
			}
			const now = Date.now();
			if (now - this.#normalEscapeAt < 500) {
				this.#normalEscapeAt = 0;
				super.handleInput(data);
			} else {
				this.#normalEscapeAt = now;
			}
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

		if (this.#visual) {
			this.#handleVisual(data);
			return;
		}

		const cur = this.getCursor();
		const len = this.#line().length;
		switch (data) {
			case "i":
				this.#setMode("insert");
				return;
			case "a":
				if (cur.col < len) super.handleInput(SEQ.right);
				this.#setMode("insert");
				return;
			case "I":
				this.#moveToCol(firstNonBlank(this.#line()));
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
				super.handleInput(SEQ.left);
				this.#setMode("insert");
				return;
			case "x":
				this.#applyRange("d", cur, { line: cur.line, col: Math.min(cur.col + this.#takeCount(), len) });
				return;
			case "X":
				this.#applyRange("d", { line: cur.line, col: Math.max(cur.col - this.#takeCount(), 0) }, cur);
				return;
			case "s":
				this.#applyRange("c", cur, { line: cur.line, col: Math.min(cur.col + this.#takeCount(), len) });
				return;
			case "D":
				this.#applyRange("d", cur, { line: cur.line, col: len });
				return;
			case "C":
				this.#applyRange("c", cur, { line: cur.line, col: len });
				return;
			case "S":
				this.#applyLines("c", cur.line, this.#countLines(cur.line));
				return;
			case "Y":
				this.#applyLines("y", cur.line, this.#countLines(cur.line));
				return;
			case "J":
				this.#join();
				return;
			case "~":
				this.#toggleCase();
				return;
			case "p":
			case "P":
				this.#put(data === "P");
				return;
			case "u": {
				this.#noRecord();
				this.#repeat(() => this.#undoChange());
				return;
			}
			case ".":
				this.#repeatChange();
				return;
			case "v":
			case "V":
				this.#visual = { anchor: cur, linewise: data === "V" };
				return;
			case "d":
			case "c":
			case "y":
				this.#op = data;
				return;
			case "g":
			case "r":
			case "f":
			case "t":
			case "F":
			case "T":
				this.#await = data;
				return;
			default:
				this.#doMotion(data);
		}
	}

	#handleVisual(data: string): void {
		const visual = this.#visual;
		if (!visual) return;
		switch (data) {
			case "v":
			case "V":
				if (visual.linewise === (data === "V")) this.#visual = null;
				else visual.linewise = data === "V";
				return;
			case "o": {
				const cur = this.getCursor();
				this.#setCursor(visual.anchor);
				visual.anchor = cur;
				return;
			}
			case "d":
			case "x":
				this.#applyVisual("d");
				return;
			case "c":
			case "s":
				this.#applyVisual("c");
				return;
			case "y":
				this.#applyVisual("y");
				return;
			case "g":
			case "i":
			case "a":
			case "f":
			case "t":
			case "F":
			case "T":
				this.#await = data;
				return;
			default:
				this.#doMotion(data);
		}
	}

	#applyVisual(op: Op): void {
		const visual = this.#visual;
		if (!visual) return;
		this.#visual = null;
		const cur = this.getCursor();
		if (visual.linewise) {
			this.#applyLines(op, Math.min(visual.anchor.line, cur.line), Math.max(visual.anchor.line, cur.line));
			return;
		}
		const [a, b] = order(visual.anchor, cur);
		this.#applyRange(op, a, { line: b.line, col: b.col + 1 });
	}

	#resolveAwait(data: string): void {
		const kind = this.#await;
		this.#await = "";
		if (kind === "g") {
			if (data !== "g") {
				this.#op = "";
				return;
			}
			const target = this.#count ? this.#takeCount() - 1 : 0;
			this.#motion(LINEWISE, () => this.#goToLineStart(target));
			return;
		}
		if (data.length !== 1 || data < " ") {
			this.#op = "";
			return;
		}
		if (kind === "r") this.#replaceChars(data);
		else if (kind === "i" || kind === "a") this.#selectObject(data, kind === "a");
		else if (kind) this.#motion({ linewise: false, inclusive: kind === "f" || kind === "t" }, () => this.#applyFind(kind, data));
	}

	#resolveOp(data: string): void {
		const op = this.#op;
		if (!op) return;
		// dd / cc / yy
		if (data === op) {
			this.#op = "";
			const { line } = this.getCursor();
			this.#applyLines(op, line, this.#countLines(line));
			return;
		}
		switch (data) {
			case "g":
			case "i":
			case "a":
			case "f":
			case "t":
			case "F":
			case "T":
				this.#await = data;
				return;
			case "j":
			case "k": {
				// Operators move by logical line; plain j/k follow wrapped rows.
				const n = this.#takeCount();
				const cur = this.getCursor();
				const line = Math.max(0, Math.min(cur.line + (data === "j" ? n : -n), this.getLines().length - 1));
				this.#motion(LINEWISE, () => this.#setCursor({ line, col: cur.col }));
				return;
			}
			case ";":
			case ",": {
				const last = this.#lastFind;
				const kind = last && (data === ";" ? last.kind : FIND_OPPOSITE[last.kind]);
				this.#motion({ linewise: false, inclusive: kind === "f" || kind === "t" }, () => this.#doMotion(data));
				return;
			}
		}
		if (op === "c" && (data === "w" || data === "W")) {
			this.#changeWord(data === "W");
			return;
		}
		const spec = motionSpec(data);
		if (!spec) {
			this.#op = "";
			return;
		}
		this.#motion(spec, () => this.#doMotion(data), data === "w" || data === "W");
	}

	/** Run `move`; with an operator pending, apply it over the text moved across. */
	#motion(spec: MotionSpec, move: () => void, stayOnLine = false): void {
		const op = this.#op;
		if (!op) {
			move();
			return;
		}
		this.#op = "";
		const start = this.getCursor();
		move();
		let end = this.getCursor();
		if (spec.linewise) {
			this.#applyLines(op, Math.min(start.line, end.line), Math.max(start.line, end.line));
			return;
		}
		// `dw` on a line's last word stops at the line end instead of joining lines.
		if (stayOnLine && end.line > start.line) end = { line: start.line, col: this.#line(start.line).length };
		const [a, b] = order(start, end);
		this.#applyRange(op, a, spec.inclusive ? { line: b.line, col: b.col + 1 } : b);
	}

	/** Vim's `cw` / `cW`: inside a word, change to its end without the trailing blanks. */
	#changeWord(big: boolean): void {
		const { line, col } = this.getCursor();
		const text = this.#line(line);
		if (col >= text.length || isSpace(text[col] ?? "")) {
			this.#motion(EXCLUSIVE, () => this.#doMotion(big ? "W" : "w"), true);
			return;
		}
		const n = this.#takeCount();
		const k = kindAt(text, col, big);
		let end = col;
		while (end + 1 < text.length && kindAt(text, end + 1, big) === k) end++;
		for (let i = 1; i < n; i++) end = wordEndForward(text, end, big) ?? end;
		this.#op = "";
		this.#applyRange("c", { line, col }, { line, col: end + 1 });
	}

	#selectObject(obj: string, around: boolean): void {
		const op = this.#op;
		this.#op = "";
		this.#count = "";
		const range = textObject(this.getLines(), this.getCursor(), obj, around);
		if (!range) return;
		if (this.#visual) {
			const lines = this.getLines();
			const endOff = toOffset(lines, range.end) - 1;
			if (endOff < toOffset(lines, range.start)) return;
			this.#visual = { anchor: range.start, linewise: false };
			this.#setCursor(toPos(lines, endOff));
			return;
		}
		if (op) this.#applyRange(op, range.start, range.end);
	}

	/** Charwise operator over `[a, b)`. */
	#applyRange(op: Op, a: Pos, b: Pos): void {
		if (a.line === b.line && a.col >= b.col) {
			if (op === "c") {
				this.#setCursor(a);
				this.#setMode("insert");
			}
			return;
		}
		this.#register = { text: sliceRange(this.getLines(), a, b), linewise: false };
		if (op === "y") {
			this.#setCursor(a);
			return;
		}
		this.#deleteRange(a, b);
		if (op === "c") this.#setMode("insert");
	}

	/** Linewise operator over lines `lo..hi`. */
	#applyLines(op: Op, lo: number, hi: number): void {
		const lines = this.getLines();
		const lenOf = (line: number): number => (lines[line] ?? "").length;
		this.#register = { text: lines.slice(lo, hi + 1).join("\n"), linewise: true };
		if (op === "y") {
			const { line, col } = this.getCursor();
			if (line !== lo) this.#setCursor({ line: lo, col });
			return;
		}
		if (op === "c") {
			this.#deleteRange({ line: lo, col: 0 }, { line: hi, col: lenOf(hi) });
			this.#setMode("insert");
			return;
		}
		if (hi < lines.length - 1) this.#deleteRange({ line: lo, col: 0 }, { line: hi + 1, col: 0 });
		else if (lo > 0) this.#deleteRange({ line: lo - 1, col: lenOf(lo - 1) }, { line: hi, col: lenOf(hi) });
		else this.#deleteRange({ line: 0, col: 0 }, { line: hi, col: lenOf(hi) });
		this.#goToLineStart(lo);
	}

	#countLines(line: number): number {
		return Math.min(line + this.#takeCount() - 1, this.getLines().length - 1);
	}

	#doMotion(data: string): void {
		switch (data) {
			case "h":
				this.#repeat(() => {
					if (this.getCursor().col > 0) super.handleInput(SEQ.left);
				});
				return;
			case "l":
				this.#repeat(() => {
					if (this.getCursor().col < this.#line().length) super.handleInput(SEQ.right);
				});
				return;
			case "j":
				this.#repeat(() => super.handleInput(SEQ.down));
				return;
			case "k":
				this.#repeat(() => super.handleInput(SEQ.up));
				return;
			case "w":
			case "W":
				this.#repeat(() => this.#stepWordStart(data === "W"));
				return;
			case "b":
			case "B":
				this.#repeat(() => this.#stepWordBack(data === "B"));
				return;
			case "e":
			case "E":
				this.#repeat(() => this.#stepWordEnd(data === "E"));
				return;
			case "^":
				this.#moveToCol(firstNonBlank(this.#line()));
				return;
			case "0":
				this.moveToLineStart();
				return;
			case "$":
				this.moveToLineEnd();
				return;
			case "G":
				this.#goToLineStart((this.#count ? this.#takeCount() : this.getLines().length) - 1);
				return;
			case ";":
				this.#replayFind(false);
				return;
			case ",":
				this.#replayFind(true);
				return;
		}
	}

	#stepWordStart(big: boolean): void {
		const { line, col } = this.getCursor();
		const lines = this.getLines();
		const dest = wordStartForward(lines[line] ?? "", col, big);
		if (dest !== null) this.#moveToCol(dest);
		else if (line + 1 < lines.length) this.#goToLineStart(line + 1);
		else this.moveToLineEnd();
	}

	#stepWordBack(big: boolean): void {
		const { line, col } = this.getCursor();
		const dest = wordStartBack(this.#line(line), col, big);
		if (dest !== null) {
			this.#moveToCol(dest);
			return;
		}
		if (line <= 0) return;
		const prev = this.#line(line - 1);
		this.#setCursor({ line: line - 1, col: wordStartBack(prev, prev.length, big) ?? 0 });
	}

	#stepWordEnd(big: boolean): void {
		const { line, col } = this.getCursor();
		const lines = this.getLines();
		const dest = wordEndForward(lines[line] ?? "", col, big);
		if (dest !== null) {
			this.#moveToCol(dest);
			return;
		}
		for (let l = line + 1; l < lines.length; l++) {
			const end = wordEndForward(lines[l] ?? "", -1, big);
			if (end !== null) {
				this.#setCursor({ line: l, col: end });
				return;
			}
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
		const dest = findLanding(this.#line(line), col, kind, ch, this.#takeCount());
		if (remember) this.#lastFind = { kind, ch };
		if (dest !== null) this.#moveToCol(dest);
	}

	#replaceChars(ch: string): void {
		const n = this.#takeCount();
		const { col } = this.getCursor();
		if (col + n > this.#line().length) return;
		this.#moveToCol(col + n);
		this.deleteBeforeCursor(n);
		this.insertText(ch.repeat(n));
		this.#moveToCol(col + n - 1);
	}

	#toggleCase(): void {
		const n = this.#takeCount();
		const { col } = this.getCursor();
		const text = this.#line();
		const end = Math.min(col + n, text.length);
		if (end <= col) return;
		const swapped = [...text.slice(col, end)]
			.map(c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
			.join("");
		this.#moveToCol(end);
		this.deleteBeforeCursor(end - col);
		this.insertText(swapped);
	}

	#join(): void {
		const joins = Math.max(this.#takeCount() - 1, 1);
		for (let i = 0; i < joins; i++) {
			const { line } = this.getCursor();
			const lines = this.getLines();
			if (line + 1 >= lines.length) return;
			const cur = lines[line] ?? "";
			const next = (lines[line + 1] ?? "").trimStart();
			const lead = (lines[line + 1] ?? "").length - next.length;
			this.#deleteRange({ line, col: cur.length }, { line: line + 1, col: lead });
			if (cur.length > 0 && !/\s$/.test(cur) && next.length > 0 && !next.startsWith(")")) this.insertText(" ");
			this.#moveToCol(cur.length);
		}
	}

	#put(before: boolean): void {
		const reg = this.#register;
		const n = this.#takeCount();
		if (!reg) return;
		const text = Array.from({ length: n }, () => reg.text).join(reg.linewise ? "\n" : "");
		const { line, col } = this.getCursor();
		if (reg.linewise) {
			if (before) {
				this.moveToLineStart();
				this.insertText(`${text}\n`);
				this.#goToLineStart(line);
			} else {
				this.moveToLineEnd();
				this.insertText(`\n${text}`);
				this.#goToLineStart(line + 1);
			}
			return;
		}
		if (!before && col < this.#line().length) super.handleInput(SEQ.right);
		const start = this.getCursor();
		this.insertText(text);
		if (text.includes("\n")) this.#setCursor(start);
		else this.#moveToCol(this.getCursor().col - 1);
	}

	#undoChange(): void {
		const entry = this.#undo.pop();
		// Text changed outside a tracked change: our entries no longer line up.
		if (!entry || entry.after !== this.getText()) {
			this.#undo.length = 0;
			super.handleInput(SEQ.undo);
			return;
		}
		for (let i = 0; i < 1000 && this.getText() !== entry.before; i++) {
			const prev = this.getText();
			super.handleInput(SEQ.undo);
			if (this.getText() === prev) return;
		}
	}

	#repeatChange(): void {
		if (this.#change) this.#change.dot = false;
		const keys = this.#lastChange;
		const n = this.#takeCount();
		this.#replaying = true;
		try {
			for (let i = 0; i < n; i++) for (const key of keys) this.#dispatch(key);
		} finally {
			this.#replaying = false;
		}
	}

	/** NORMAL mode never rests past the last char (Vim's cursor model). */
	#clampCursor(): void {
		const { col } = this.getCursor();
		const len = this.#line().length;
		if (len > 0 && col >= len) this.#moveToCol(len - 1);
	}

	#goToLineStart(line: number): void {
		const target = Math.max(0, Math.min(line, this.getLines().length - 1));
		this.#setCursor({ line: target, col: firstNonBlank(this.#line(target)) });
	}

	/** Move by logical lines (Home+Left / End+Right), so wrapped rows never skew the target. */
	#setCursor(pos: Pos): void {
		const lines = this.getLines();
		const line = Math.max(0, Math.min(pos.line, lines.length - 1));
		while (this.getCursor().line !== line) {
			const before = this.getCursor().line;
			if (before < line) {
				this.moveToLineEnd();
				super.handleInput(SEQ.right);
			} else {
				this.moveToLineStart();
				super.handleInput(SEQ.left);
			}
			if (this.getCursor().line === before) break;
		}
		this.#moveToCol(Math.min(pos.col, (lines[line] ?? "").length));
	}

	/** Step within the current line; arrows move by grapheme, so stop once past `col`. */
	#moveToCol(col: number): void {
		const cur = this.getCursor().col;
		const len = this.#line().length;
		if (col < Math.abs(cur - col)) this.moveToLineStart();
		else if (len - col < Math.abs(cur - col)) this.moveToLineEnd();
		if (this.getCursor().col < col) {
			while (this.getCursor().col < col) super.handleInput(SEQ.right);
		} else {
			while (this.getCursor().col > col) super.handleInput(SEQ.left);
		}
	}

	/** Delete `[a, b)`. */
	#deleteRange(a: Pos, b: Pos): void {
		this.#setCursor(b);
		// ponytail: no range-delete API; one base undo step per line (`u` regroups them).
		for (;;) {
			const c = this.getCursor();
			if (c.line < a.line || (c.line === a.line && c.col <= a.col)) return;
			if (c.col > 0) this.deleteBeforeCursor(c.line === a.line ? c.col - a.col : c.col);
			else super.handleInput(SEQ.backspace);
			const after = this.getCursor();
			if (after.line === c.line && after.col === c.col) return;
		}
	}

	override render(width: number): readonly string[] {
		const rows = super.render(width);
		if (this.#mode !== "normal" || width <= 0 || !this.focused) return rows;
		const label = this.#visual ? (this.#visual.linewise ? "-- VISUAL LINE --" : "-- VISUAL --") : "-- NORMAL --";
		return [...rows, `\x1b[2m${label}\x1b[0m`];
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
