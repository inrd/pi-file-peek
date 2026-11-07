import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { __test } from "../extensions/file-peek.ts";
import { refs, say, toolCall, toolResult, workspace } from "./helpers.ts";

const { dir, cleanup } = workspace({
	"src/a.ts": 100,
	"src/b.ts": 100,
	"big.ts": 500,
	"packages/x/index.ts": 50,
	"packages/x/util.ts": 50,
	"packages/x/lib/deep.ts": 50,
	"packages/y/index.ts": 50,
	"Screenshot 2026-11-07 at 10.00.00\u202FAM.png": "png",
	"Capture d\u2019e\u0301cran.png": "png",
});
after(cleanup);

describe("tool calls", () => {
	test("read uses its offset, write uses line 1", () => {
		assert.deepEqual(refs(dir, [toolCall("read", { path: "src/a.ts", offset: 40 }), toolCall("write", { path: "src/b.ts" })]), [
			"src/b.ts:1",
			"src/a.ts:40",
		]);
	});

	test("edit jumps to the first changed line from its result", () => {
		const call = toolCall("edit", { path: "src/a.ts" });
		const id = ((call.message.content as Array<{ id: string }>)[0]).id;
		const result = {
			type: "message" as const,
			message: { role: "toolResult", toolName: "edit", toolCallId: id, content: [], details: { firstChangedLine: 17 } },
		};
		assert.deepEqual(refs(dir, [call, result]), ["src/a.ts:17"]);
	});

	test("paths are resolved like Pi's tools (@, unicode spaces, file://)", () => {
		assert.deepEqual(refs(dir, [toolCall("read", { path: "@src/a.ts" })]), ["src/a.ts:1"]);
		assert.deepEqual(refs(dir, [toolCall("read", { path: `file://${dir}/src/b.ts` })]), ["src/b.ts:1"]);
	});

	test("macOS screenshot name variants resolve", () => {
		const { resolveExistingToolPath } = __test;
		assert.ok(resolveExistingToolPath("Screenshot 2026-11-07 at 10.00.00 AM.png", dir).endsWith("\u202FAM.png"));
		assert.ok(resolveExistingToolPath("Capture d'écran.png", dir).includes("\u2019"));
		assert.equal(resolveExistingToolPath("missing.ts", dir), `${dir}/missing.ts`);
	});
});

describe("prose references", () => {
	test("path:line and #L anchors", () => {
		assert.deepEqual(refs(dir, [say("See src/a.ts:33:4 and [b](src/b.ts#L12-L20).")]), ["src/b.ts:12", "src/a.ts:33"]);
		assert.deepEqual(refs(dir, [say("Column `src/a.ts#L12C5`.")]), ["src/a.ts:12"]);
		assert.deepEqual(refs(dir, [say("Anchor src/a.ts#section is not a line.")]), ["src/a.ts:1"]);
	});

	test("loose 'at line N' attaches to the nearest preceding path", () => {
		assert.deepEqual(refs(dir, [say("`src/a.ts` sets it up. Then `src/b.ts` validates it at line 40.")]), [
			"src/b.ts:40",
			"src/a.ts:1",
		]);
	});

	test("explicit 'line N of path' wins over proximity", () => {
		assert.deepEqual(refs(dir, [say("`src/a.ts` calls `src/b.ts`. The bug is at line 30 of `src/a.ts`.")]), [
			"src/a.ts:30",
			"src/b.ts:1",
		]);
	});

	test("with no preceding path, falls back to the first path", () => {
		assert.deepEqual(refs(dir, [say("At line 12 the cache is built. See `src/a.ts`, then `src/b.ts`.")]), [
			"src/a.ts:12",
			"src/b.ts:1",
		]);
	});

	test("line numbers inside fenced code are ignored", () => {
		assert.deepEqual(refs(dir, [say("`src/a.ts`:\n```\nthrow at line 99\n```")]), ["src/a.ts:1"]);
	});

	test("tool results feed base dirs but not the picker", () => {
		assert.deepEqual(refs(dir, [toolResult("packages/x/lib/deep.ts:3: match"), say("See `lib/deep.ts`.")]), [
			"packages/x/lib/deep.ts:1",
		]);
	});
});

describe("bare filenames", () => {
	const read = (path: string) => toolCall("read", { path });
	const mention = say("Look at `index.ts:7`.");

	test("prefer the candidate nearest the recent context", () => {
		const out = refs(dir, [read("packages/x/index.ts"), read("packages/y/index.ts"), read("packages/x/util.ts"), mention]);
		assert.equal(out[0], "packages/x/index.ts:7");
	});

	test("work from nested directories", () => {
		const out = refs(dir, [read("packages/x/index.ts"), read("packages/y/index.ts"), read("packages/x/lib/deep.ts"), mention]);
		assert.equal(out[0], "packages/x/index.ts:7");
	});

	test("skip ambiguous names rather than guess", () => {
		const out = refs(dir, [read("packages/x/index.ts"), read("packages/y/index.ts"), read("src/a.ts"), mention]);
		assert.ok(!out.some((ref) => ref.endsWith(":7")), out.join(", "));
	});

	test("a single candidate always resolves", () => {
		assert.equal(refs(dir, [read("packages/y/index.ts"), read("src/a.ts"), mention])[0], "packages/y/index.ts:7");
	});
});

describe("picker list", () => {
	test("caps entries per file so one file cannot fill the picker", () => {
		const reads = Array.from({ length: 45 }, (_, i) => toolCall("read", { path: "big.ts", offset: 1 + i * 10 }));
		const out = refs(dir, [toolCall("read", { path: "src/a.ts" }), toolCall("read", { path: "src/b.ts" }), ...reads]);
		assert.deepEqual(out, ["big.ts:441", "big.ts:431", "big.ts:421", "src/b.ts:1", "src/a.ts:1"]);
	});

	test("drops the generic line-1 mention when a specific line exists", () => {
		assert.deepEqual(refs(dir, [say("`src/b.ts` at line 5, see `src/a.ts`."), say("`src/b.ts` again.")]), [
			"src/b.ts:5",
			"src/a.ts:1",
		]);
	});
});

describe("/peek arguments", () => {
	const target = (input: string) => {
		const ref = __test.parseTarget(input, dir);
		return ref && `${ref.displayPath}:${ref.line}`;
	};

	test("path, path:line, path#Lline", () => {
		assert.equal(target("src/a.ts"), "src/a.ts:1");
		assert.equal(target("src/a.ts:9"), "src/a.ts:9");
		assert.equal(target("src/a.ts#L42-L50"), "src/a.ts:42");
		assert.equal(target("nope.ts"), undefined);
	});
});
