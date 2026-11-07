import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { __test } from "../extensions/file-peek.ts";

const { editorSpec, isValidShortcut, splitCommandLine } = __test;

describe("splitCommandLine", () => {
	const cases: Array<[string, string[]]> = [
		["vim", ["vim"]],
		["  code   --wait ", ["code", "--wait"]],
		["'/Applications/My Editor.app/bin/ed' --wait", ["/Applications/My Editor.app/bin/ed", "--wait"]],
		['"/opt/my editor/ed" -n', ["/opt/my editor/ed", "-n"]],
		["/opt/my\\ editor/ed", ["/opt/my editor/ed"]],
		['emacsclient -a "" -t', ["emacsclient", "-a", "", "-t"]],
		['ed "say \\"hi\\""', ["ed", 'say "hi"']],
		["C:\\Tools\\ed.exe", ["C:\\Tools\\ed.exe"]],
		["foo'bar baz'qux", ["foobar bazqux"]],
		["'unterminated arg", ["unterminated arg"]],
		["", []],
	];
	for (const [input, expected] of cases) {
		test(JSON.stringify(input), () => assert.deepEqual(splitCommandLine(input), expected));
	}
});

describe("editorSpec", () => {
	const saved = process.env.FILE_PEEK_EDITOR;
	afterEach(() => {
		if (saved === undefined) delete process.env.FILE_PEEK_EDITOR;
		else process.env.FILE_PEEK_EDITOR = saved;
	});

	const path = "/w/a b.ts";
	const argv = (editor: string) => {
		process.env.FILE_PEEK_EDITOR = editor;
		const spec = editorSpec(path, 12);
		return [spec.command, ...spec.args];
	};

	const cases: Array<[string, string[]]> = [
		["vim", ["vim", "+12", path]],
		["nvim", ["nvim", "+12", path]],
		["code --wait", ["code", "--wait", "--goto", `${path}:12`]],
		["cursor --wait", ["cursor", "--wait", "--goto", `${path}:12`]],
		["windsurf", ["windsurf", "--goto", `${path}:12`]],
		["Code.cmd", ["Code.cmd", "--goto", `${path}:12`]],
		["/usr/local/bin/subl -w", ["/usr/local/bin/subl", "-w", `${path}:12`]],
		["zed --wait", ["zed", "--wait", `${path}:12`]],
		["hx", ["hx", `${path}:12`]],
		["idea --wait", ["idea", "--wait", "--line", "12", path]],
		["idea64.exe", ["idea64.exe", "--line", "12", path]],
		["pycharm", ["pycharm", "--line", "12", path]],
		["mate -w", ["mate", "-w", "-l", "12", path]],
		["'/Apps/My Editor/emacs' -nw", ["/Apps/My Editor/emacs", "-nw", "+12", path]],
		["ideas", ["ideas", "+12", path]],
	];
	for (const [editor, expected] of cases) {
		test(editor, () => assert.deepEqual(argv(editor), expected));
	}
});

describe("isValidShortcut", () => {
	for (const key of ["alt+o", "ctrl+shift+o", "alt+pageup", "ctrl++", "f12", "super+k"]) {
		test(`accepts ${key}`, () => assert.ok(isValidShortcut(key)));
	}
	for (const key of ["bogus+key", "ctrl+ctrl+o", "f13", "", "ctrl+"]) {
		test(`rejects ${JSON.stringify(key)}`, () => assert.ok(!isValidShortcut(key)));
	}
});
