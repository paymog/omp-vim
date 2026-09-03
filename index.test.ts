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
