import { expect, test } from "bun:test";
import { bigWordEnd, bigWordStartBack, bigWordStartForward, charwiseSpan, findLanding, firstNonBlank, wordEnd } from "./index.ts";

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
	expect(wordEnd("hello world", 0, 1)).toBe(4);
	expect(wordEnd("hello world", 4, 1)).toBe(10);
	expect(wordEnd("hello world", 5, 1)).toBe(10);
	expect(wordEnd("hello world", 0, 2)).toBe(10);
	expect(wordEnd("hello", 4, 1)).toBeNull();
	expect(wordEnd("ab ... cd", 0, 2)).toBe(5);
});

test("W B E and caret on a line", () => {
	expect(bigWordStartForward("foo.bar baz", 0)).toBe(8);
	expect(bigWordStartForward("foo.bar baz", 8)).toBeNull();
	expect(bigWordStartBack("foo.bar baz", 10)).toBe(8);
	expect(bigWordStartBack("foo.bar baz", 8)).toBe(0);
	expect(bigWordStartBack("foo.bar baz", 0)).toBeNull();
	expect(bigWordEnd("foo.bar baz", 0, 1)).toBe(6);
	expect(bigWordEnd("foo.bar baz", 6, 1)).toBe(10);
	expect(bigWordEnd("foo.bar", 6, 1)).toBeNull();
	expect(firstNonBlank("  hi")).toBe(2);
	expect(firstNonBlank("hi")).toBe(0);
	expect(firstNonBlank("   ")).toBe(0);
});

test("charwiseSpan exclusive vs inclusive", () => {
	expect(charwiseSpan(0, 5, false)).toEqual({ end: 5, n: 5 });
	expect(charwiseSpan(0, 4, true)).toEqual({ end: 5, n: 5 });
	expect(charwiseSpan(5, 4, false)).toEqual({ end: 5, n: 1 });
	expect(charwiseSpan(5, 2, true)).toEqual({ end: 6, n: 4 });
	expect(charwiseSpan(3, 3, false)).toBeNull();
});
