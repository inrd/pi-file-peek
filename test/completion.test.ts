import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import filePeekExtension, { __test } from "../extensions/file-peek.ts";
import { say, toolCall, workspace } from "./helpers.ts";

const { collectRefs, parseTarget, peekCompletions } = __test;

const { dir, cleanup } = workspace({
	"src/auth/login.ts": 50,
	"src/auth/session.ts": 50,
	"docs/my notes.md": 10,
});
after(cleanup);

function contextFor(entries: unknown[], leafId = "leaf-1"): ExtensionContext {
	return {
		cwd: dir,
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => entries, getLeafId: () => leafId },
	} as unknown as ExtensionContext;
}

const session = [
	toolCall("read", { path: "src/auth/login.ts", offset: 12 }),
	toolCall("read", { path: "docs/my notes.md" }),
	say("The check is in src/auth/session.ts:30."),
];
const refs = collectRefs(contextFor(session));
const values = (items: AutocompleteItem[] | null) => items?.map((item) => item.value) ?? null;

describe("peekCompletions", () => {
	test("empty prefix offers last, then every recent reference", () => {
		assert.deepEqual(values(peekCompletions("", refs)), [
			"last",
			"src/auth/session.ts:30",
			"docs/my notes.md:1",
			"src/auth/login.ts:12",
		]);
	});

	test("last describes what it would open", () => {
		const last = peekCompletions("la", refs)?.find((item) => item.value === "last");
		assert.match(last?.description ?? "", /src\/auth\/session\.ts:30/);
	});

	test("fuzzy-matches paths", () => {
		assert.deepEqual(values(peekCompletions("sess", refs)), ["src/auth/session.ts:30"]);
		assert.deepEqual(values(peekCompletions("authlog", refs)), ["src/auth/login.ts:12"]);
	});

	test("no session references: no suggestions, not even last", () => {
		assert.equal(peekCompletions("", []), null);
		assert.equal(peekCompletions("zzz", refs), null);
	});

	test("every suggestion is accepted by /peek as-is, including spaces", () => {
		for (const item of peekCompletions("", refs) ?? []) {
			if (item.value === "last") continue;
			const target = parseTarget(item.value, dir);
			assert.ok(target, item.value);
			assert.equal(`${target.displayPath}:${target.line}`, item.value);
		}
	});
});

describe("/peek completion wiring", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;

	function load() {
		const handlers = new Map<string, Handler[]>();
		let complete: ((prefix: string) => unknown) | undefined;
		const api = {
			registerCommand: (_name: string, options: { getArgumentCompletions?: (prefix: string) => unknown }) => {
				complete = options.getArgumentCompletions;
			},
			registerShortcut() {},
			on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		} as unknown as ExtensionAPI;
		filePeekExtension(api);
		const emit = async (type: string, ctx?: unknown) => {
			for (const handler of handlers.get(type) ?? []) await handler({ type, reason: "startup" }, ctx);
		};
		return { complete: (prefix: string) => complete?.(prefix) as AutocompleteItem[] | null, emit };
	}

	test("before session_start and after shutdown there is nothing to suggest", async () => {
		const { complete, emit } = load();
		assert.equal(complete(""), null);
		await emit("session_start", contextFor(session));
		assert.ok((complete("") ?? []).length > 0);
		await emit("session_shutdown");
		assert.equal(complete(""), null);
	});

	test("refreshes when the session moves on, not on every keystroke", async () => {
		const { complete, emit } = load();
		const entries = [toolCall("read", { path: "src/auth/login.ts" })];
		let leafId = "a";
		const ctx = {
			cwd: dir,
			sessionManager: { getBranch: () => entries, getLeafId: () => leafId },
		} as unknown as ExtensionContext;
		await emit("session_start", ctx);

		assert.deepEqual(values(complete("")), ["last", "src/auth/login.ts:1"]);
		entries.push(toolCall("read", { path: "src/auth/session.ts" }));
		assert.deepEqual(values(complete("")), ["last", "src/auth/login.ts:1"], "cached while the leaf is unchanged");
		leafId = "b";
		assert.deepEqual(values(complete("")), ["last", "src/auth/session.ts:1", "src/auth/login.ts:1"]);
	});

	test("a failing session never breaks typing", async () => {
		const { complete, emit } = load();
		const broken = {
			cwd: dir,
			sessionManager: {
				getLeafId: () => {
					throw new Error("stale context");
				},
			},
		};
		await emit("session_start", broken);
		assert.equal(complete(""), null);
	});
});
