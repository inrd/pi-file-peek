import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { __test } from "../extensions/file-peek.ts";
import { plainTheme } from "./helpers.ts";

const { FilePeekView, overlayRowBudget } = __test;

// highlightCode reads Pi's global theme, which Pi itself sets up at startup.
before(() => initTheme("dark"));

function view(rawLines: string[], line: number, rows = 40, language: string | undefined = undefined) {
	const tui = { terminal: { rows }, requestRender() {} } as unknown as TUI;
	const target = { absPath: "/x.ts", displayPath: "x.ts", line, source: "peek" as const };
	let result: unknown;
	const v = new FilePeekView(tui, plainTheme, target, { rawLines, language, truncated: false }, (r) => {
		result = r;
	});
	return { v, result: () => result };
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);
const text = (lines: string[]) => lines.map(stripTerminalSequences);

describe("layout", () => {
	for (const rows of [3, 4, 5, 6, 8, 24, 60]) {
		test(`${rows} rows: fits Pi's overlay budget and shows the cursor`, () => {
			const out = text(view(numbered(100), 50, rows).v.render(80));
			assert.ok(out.length <= overlayRowBudget(rows), `${out.length} > ${overlayRowBudget(rows)}`);
			assert.ok(out.some((l) => l.includes("▌") && l.includes("line 50")));
			if (rows >= 6) {
				assert.match(out[0], /peek x\.ts:50/);
				assert.match(out.at(-1) ?? "", /q close/);
			}
		});
	}

	test("empty file", () => {
		assert.ok(text(view([], 1).v.render(80)).some((l) => l.includes("(empty file)")));
	});
});

describe("keys", () => {
	test("j/k/G/g move the cursor; e reports the line", () => {
		const { v, result } = view(numbered(100), 10);
		v.handleInput("j");
		v.handleInput("j");
		v.handleInput("k");
		v.handleInput("e");
		assert.deepEqual(result(), { action: "edit", line: 11 });

		v.handleInput("G");
		v.handleInput("e");
		assert.deepEqual(result(), { action: "edit", line: 100 });
		v.handleInput("g");
		v.handleInput("e");
		assert.deepEqual(result(), { action: "edit", line: 1 });
	});

	test("q closes", () => {
		const { v, result } = view(numbered(5), 1);
		v.handleInput("q");
		assert.deepEqual(result(), { action: "close" });
	});
});

describe("highlighting", () => {
	const code = 'export function f(a: number): string { return `${a}`; } // comment';

	test("large files only highlight what is on screen, and quickly", () => {
		const { v } = view(Array(12_000).fill(code), 9_000, 40, "typescript");
		const start = performance.now();
		v.render(120);
		const elapsed = performance.now() - start;
		const state = v as unknown as { highlightedChunks: Set<number>; highlighted: Array<string | undefined> };
		assert.ok(state.highlightedChunks.size <= 2, `chunks: ${[...state.highlightedChunks]}`);
		assert.equal(state.highlighted[0], undefined, "far-away lines are not highlighted");
		assert.ok(elapsed < 250, `${elapsed.toFixed(0)}ms`);
	});

	test("invalidate drops colours and redoes only the visible chunks", () => {
		const { v } = view(Array(12_000).fill(code), 9_000, 40, "typescript");
		v.render(120);
		v.invalidate();
		const state = v as unknown as { highlightedChunks: Set<number> };
		assert.equal(state.highlightedChunks.size, 0);
		v.render(120);
		assert.ok(state.highlightedChunks.size > 0 && state.highlightedChunks.size <= 2);
	});
});
