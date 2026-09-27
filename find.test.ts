import { expect, test } from "bun:test";
import { findLanding, firstNonBlank, textObject, wordEndForward, wordStartBack, wordStartForward } from "./index.ts";

const line = "ab.cd.ef";

test("f lands on the next match", () => {
	expect(findLanding(line, 0, "f", ".", 1)).toBe(2);
	expect(findLanding(line, 0, "f", ".", 2)).toBe(5);
	expect(findLanding(line, 0, "f", ".", 3)).toBeNull();
	expect(findLanding(line, 2, "f", ".", 1)).toBe(5);
});

test("t lands on the char before the match", () => {
	expect(findLanding(line, 0, "t", ".", 1)).toBe(1);
	expect(findLanding(line, 0, "t", ".", 2)).toBe(4);
	expect(findLanding("a.b", 0, "t", ".", 1)).toBeNull();
});

test("F and T search backward", () => {
	expect(findLanding(line, 8, "F", ".", 1)).toBe(5);
	expect(findLanding(line, 8, "F", ".", 2)).toBe(2);
	expect(findLanding(line, 8, "T", ".", 1)).toBe(6);
	expect(findLanding(line, 6, "T", ".", 1)).toBeNull();
	expect(findLanding(line, 0, "F", ".", 1)).toBeNull();
});

test("missing char is a no-op", () => {
	expect(findLanding(line, 0, "f", "z", 1)).toBeNull();
	expect(findLanding(line, 8, "F", "z", 1)).toBeNull();
});

test("e lands on word end", () => {
	expect(wordEndForward("hello world", 0, false)).toBe(4);
	expect(wordEndForward("hello world", 4, false)).toBe(10);
	expect(wordEndForward("hello world", 5, false)).toBe(10);
	expect(wordEndForward("hello", 4, false)).toBeNull();
	expect(wordEndForward("ab ... cd", 1, false)).toBe(5);
	expect(wordEndForward("  foo", -1, false)).toBe(4);
});

test("w and b stop at punctuation; W and B only at blanks", () => {
	expect(wordStartForward("foo.bar baz", 0, false)).toBe(3);
	expect(wordStartForward("foo.bar baz", 0, true)).toBe(8);
	expect(wordStartForward("foo.bar baz", 8, true)).toBeNull();
	expect(wordStartBack("foo.bar baz", 8, false)).toBe(4);
	expect(wordStartBack("foo.bar baz", 8, true)).toBe(0);
	expect(wordStartBack("foo.bar baz", 0, true)).toBeNull();
	expect(wordEndForward("foo.bar baz", 0, true)).toBe(6);
	expect(wordEndForward("foo.bar", 6, true)).toBeNull();
	expect(firstNonBlank("  hi")).toBe(2);
	expect(firstNonBlank("   ")).toBe(0);
});

test("text objects", () => {
	const at = (text: string, col: number, obj: string, around: boolean) => {
		const r = textObject(text.split("\n"), { line: 0, col }, obj, around);
		return r && text.slice(r.start.col, r.end.line === 0 ? r.end.col : undefined);
	};
	expect(at("foo bar baz", 5, "w", false)).toBe("bar");
	expect(at("foo bar baz", 5, "w", true)).toBe("bar ");
	expect(at("foo bar", 5, "w", true)).toBe(" bar");
	expect(at('say "hi there" ok', 0, '"', false)).toBe("hi there");
	expect(at('say "hi there" ok', 6, '"', true)).toBe('"hi there"');
	expect(at("f(a, (b), c)", 3, "(", false)).toBe("a, (b), c");
	expect(at("f(a, (b), c)", 6, "b", true)).toBe("(b)");
	expect(at("f(a, (b), c)", 11, ")", false)).toBe("a, (b), c");
	expect(at("no brackets", 3, "(", false)).toBeNull();
	const multi = textObject(["{", "  x", "}"], { line: 1, col: 2 }, "B", false);
	expect(multi).toEqual({ start: { line: 0, col: 1 }, end: { line: 2, col: 0 } });
});
