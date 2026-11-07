import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { __test } from "../extensions/file-peek.ts";

export const { collectRefs } = __test;

/** A throwaway directory with the given files (each `lines` lines long). */
export function workspace(files: Record<string, number | string>): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "file-peek-test-"));
	for (const [path, content] of Object.entries(files)) {
		const abs = join(dir, path);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, typeof content === "number" ? "x\n".repeat(content) : content);
	}
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

type Entry = { type: "message"; message: Record<string, unknown> };
let callId = 0;

export function toolCall(name: string, args: Record<string, unknown>): Entry {
	return {
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: `call-${++callId}`, name, arguments: args }] },
	};
}

export function say(text: string): Entry {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

export function toolResult(text: string): Entry {
	return { type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } };
}

/** Run collectRefs over a fake session branch and return `path:line` strings, newest first. */
export function refs(cwd: string, entries: Entry[]): string[] {
	const ctx = { cwd, sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
	return collectRefs(ctx).map((ref) => `${ref.displayPath}:${ref.line}`);
}

/** Minimal theme: the viewer only needs fg/bg/bold, and plain text keeps assertions simple. */
export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
