import { expect, test } from "bun:test";
import type { EditorTheme } from "@oh-my-pi/pi-tui";
import { VimEditor } from "./index.ts";

const theme = {
	borderColor: (value: string) => value,
	selectList: {},
	symbols: {},
} as EditorTheme;

test("double Esc in normal mode interrupts", () => {
	const editor = new VimEditor(theme);
	const interrupts = { count: 0 };
	editor.onEscape = () => {
		interrupts.count++;
	};

	editor.handleInput("\x1b");
	editor.handleInput("\x1b");
	expect(interrupts.count).toBe(0);

	editor.handleInput("\x1b");
	expect(interrupts.count).toBe(1);
});

test("a bundled double-Esc interrupts in normal mode", () => {
	const editor = new VimEditor(theme);
	const interrupts = { count: 0 };
	editor.onEscape = () => {
		interrupts.count++;
	};

	editor.handleInput("\x1b");
	editor.handleInput("\x1b\x1b");
	expect(interrupts.count).toBe(1);
});

/** Type `text` (multi-line via setText), press Esc, then run `keys` in NORMAL mode. */
function run(text: string, keys: string[]): VimEditor {
	const editor = new VimEditor(theme);
	if (text.includes("\n")) editor.setText(text);
	else for (const ch of text) editor.handleInput(ch);
	editor.handleInput("\x1b");
	for (const key of keys) editor.handleInput(key);
	return editor;
}

const ESC = "\x1b";
const cases: Array<[string, string, string[], string]> = [
	["x at line end after Esc", "hello", ["x"], "hell"],
	["X", "hello", ["X"], "helo"],
	["r with count", "hello", ["0", "3", "r", "x"], "xxxlo"],
	["~", "hello", ["0", "~"], "Hello"],
	["x on empty line does not join", "\nab", ["g", "g", "x"], "\nab"],
	["dw stops at next word start", "hello world", ["0", "d", "w"], "world"],
	["dw on last word keeps the newline", "a b\nc", ["g", "g", "w", "d", "w"], "a \nc"],
	["cw on a one-char word", "a b", ["0", "c", "w", "z", ESC], "z b"],
	["dF is exclusive", "ab.cd", ["d", "F", "."], "abd"],
	["diw", "foo bar baz", ["0", "w", "d", "i", "w"], "foo  baz"],
	["daw", "foo bar baz", ["0", "w", "d", "a", "w"], "foo baz"],
	['ci"', 'say "hi there" ok', ["0", "c", "i", '"', "x"], 'say "x" ok'],
	["xp swaps chars", "ab", ["0", "x", "p"], "ba"],
	["ddp swaps lines", "a\nb", ["g", "g", "d", "d", "p"], "b\na"],
	["yw then P", "foo bar", ["0", "y", "w", "$", "P"], "foo bafoo r"],
	["2yy G p", "a\nb\nc", ["g", "g", "2", "y", "y", "G", "p"], "a\nb\nc\na\nb"],
	["3J", "a\n  b\nc", ["g", "g", "3", "J"], "a b c"],
	["V j d", "a\nb\nc", ["g", "g", "V", "j", "d"], "c"],
	["v l l d", "hello", ["0", "v", "l", "l", "d"], "lo"],
	["viw d", "foo bar baz", ["0", "w", "v", "i", "w", "d"], "foo  baz"],
	["dgg", "a\nb\nc", ["G", "d", "g", "g"], ""],
	["u undoes a whole change", "foo bar", ["0", "c", "i", "w", "x", "y", "z", ESC, "u"], "foo bar"],
	["u undoes a multi-line delete", "a\nb\nc\nd", ["g", "g", "d", "2", "j", "u"], "a\nb\nc\nd"],
	[". repeats the last change", "foo bar", ["0", "c", "i", "w", "x", ESC, "w", "."], "x x"],
];

for (const [name, text, keys, want] of cases) {
	test(name, () => {
		expect(run(text, keys).getText()).toBe(want);
	});
}

test("Esc and $ keep the cursor on the last char", () => {
	expect(run("hello", []).getCursor().col).toBe(4);
	expect(run("hello", ["0", "$"]).getCursor().col).toBe(4);
	expect(run("ab\ncd", ["g", "g", "l", "l", "l"]).getCursor()).toEqual({ line: 0, col: 1 });
	expect(run("ab\ncd", ["g", "g", "w"]).getCursor()).toEqual({ line: 1, col: 0 });
});
