/**
 * /peek - browse recently referenced files without leaving Pi.
 *
 * The viewer shows a syntax-highlighted, read-only view at the line the agent
 * referenced. Press `e` to open the same file in your real editor at the
 * selected line; Pi suspends while the editor runs, then the viewer reopens.
 *
 * Usage:
 *   /peek                  pick from files referenced in this session
 *   /peek last             open the most recent reference
 *   /peek path[:line]      open a file directly
 *
 * Shortcut:
 *   alt+o                  open the recent-reference picker
 *   Override with $FILE_PEEK_SHORTCUT (e.g. "ctrl+shift+o"), or "none" to disable.
 *
 * Editor selection:
 *   $FILE_PEEK_EDITOR, then $VISUAL, then $EDITOR, then `vim`.
 *   The command may include arguments, e.g. `FILE_PEEK_EDITOR="code --wait"`.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { Component, KeyId, TUI } from "@earendil-works/pi-tui";
import {
	decodeKittyPrintable,
	matchesKey,
	replaceControlCharacters,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const MAX_FILE_BYTES = 1_500_000;
const MAX_FILE_LINES = 12_000;
const MAX_REFS = 40;
/** Path-like tokens tried per tool-result block, whether or not they resolve. */
const MAX_OBSERVED_TOKENS = 500;
/** Resolved paths observed per tool-result block. */
const MAX_OBSERVED_PATHS = 300;
const SOURCE_TOOLS = new Set(["read", "edit", "write"]);
/**
 * alt+o is unbound in Pi and is delivered by legacy terminals (ESC o) as well
 * as the Kitty protocol. The previous ctrl+shift+o only exists with the Kitty
 * protocol; legacy terminals send plain ctrl+o (Pi's tool-output toggle).
 */
const DEFAULT_SHORTCUT = "alt+o";

const SHORTCUT_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SHORTCUT_SPECIAL_KEYS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
	"home", "end", "pageup", "pagedown", "up", "down", "left", "right",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

/**
 * Pi accepts any string as a shortcut, so a typo would silently never fire.
 * Check the shape against pi-tui's KeyId: unique modifiers plus one key.
 */
function isValidShortcut(shortcut: string): boolean {
	// Split on "+" but keep a trailing "+" key (e.g. "ctrl++").
	const parts = shortcut.endsWith("++") ? [...shortcut.slice(0, -2).split("+"), "+"] : shortcut.split("+");
	const key = parts.pop();
	if (!key) return false;
	if (new Set(parts).size !== parts.length || !parts.every((part) => SHORTCUT_MODIFIERS.has(part))) return false;
	return key.length === 1 ? /[a-z0-9`\-=[\]\\;',./!@#$%^&*()_+|~{}:<>?]/.test(key) : SHORTCUT_SPECIAL_KEYS.has(key);
}

type RefSource = "read" | "edit" | "write" | "mention" | "peek";

interface FileRef {
	absPath: string;
	displayPath: string;
	line: number;
	source: RefSource;
}

interface LoadedFile {
	rawLines: string[];
	language: string | undefined;
	truncated: boolean;
}

interface ViewResult {
	action: "close" | "edit";
	line?: number;
}

function printableKey(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty) return kitty;
	if (data.length === 1 && data >= " " && data !== "\x7f") return data;
	return undefined;
}

/** Cache of absolute path -> "is a regular file", scoped to one scan. */
type FileCache = Map<string, boolean>;

function isFileAt(absPath: string, cache?: FileCache): boolean {
	const cached = cache?.get(absPath);
	if (cached !== undefined) return cached;

	let result = false;
	try {
		result = statSync(absPath, { throwIfNoEntry: false })?.isFile() ?? false;
	} catch {
		// ENOTDIR, EACCES, ... are all "not a file we can show".
		result = false;
	}
	cache?.set(absPath, result);
	return result;
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

function displayPath(absPath: string, cwd: string): string {
	const rel = relative(cwd, absPath);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absPath;
}

function refFromAbsolute(
	absPath: string,
	line: number,
	source: RefSource,
	cwd: string,
	cache?: FileCache,
): FileRef | undefined {
	if (!isFileAt(absPath, cache)) return undefined;
	return {
		absPath,
		displayPath: displayPath(absPath, cwd),
		line: Math.max(1, Math.floor(Number.isFinite(line) ? line : 1)),
		source,
	};
}

function makeRef(
	inputPath: string,
	line: number,
	source: RefSource,
	cwd: string,
	cache?: FileCache,
): FileRef | undefined {
	return refFromAbsolute(resolve(cwd, expandHome(inputPath)), line, source, cwd, cache);
}

// Mirrors Pi's tool path handling (core/tools/path-utils.ts and
// utils/paths.ts), which is not exported. Keep in sync if Pi changes it.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths for native Windows APIs. */
function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/** Resolve a tool's `path` argument the way the read/edit/write tools do. */
function resolveToolPath(inputPath: string, cwd: string): string {
	let normalized = inputPath.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);

	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (/^file:\/\//.test(normalized)) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// Malformed file URL: fall through and let the existence check fail.
		}
	}
	return resolve(cwd, normalized);
}

/**
 * Like Pi's read tool: if the resolved path does not exist, try the macOS
 * filename variants (screenshot AM/PM spacing, NFD, curly apostrophe).
 * Harmless for edit/write, whose paths resolve directly.
 */
function resolveExistingToolPath(inputPath: string, cwd: string, cache?: FileCache): string {
	const resolved = resolveToolPath(inputPath, cwd);
	if (isFileAt(resolved, cache)) return resolved;

	const curly = (path: string) => path.replace(/'/g, "\u2019");
	const nfd = resolved.normalize("NFD");
	const variants = [
		resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		nfd,
		curly(resolved),
		curly(nfd),
	];
	for (const variant of variants) {
		if (variant !== resolved && isFileAt(variant, cache)) return variant;
	}
	return resolved;
}

function makeToolRef(
	inputPath: string,
	line: number,
	source: RefSource,
	cwd: string,
	cache?: FileCache,
): FileRef | undefined {
	return refFromAbsolute(resolveExistingToolPath(inputPath, cwd, cache), line, source, cwd, cache);
}

interface RefContext {
	cwd: string;
	/** Candidate base dirs, most useful first. */
	bases: string[];
	/** Bare filenames already seen, e.g. Panel.vue -> absolute path. */
	byBasename: Map<string, string>;
	/** Memoized file checks; the same candidates recur across the session. */
	fileCache: FileCache;
}

interface PathMatch {
	ref: FileRef;
	start: number;
	end: number;
}

function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Base dirs worth trying for a referenced file: its own directory first, then
 * its ancestors up to the project root. The ancestors make alias-style paths
 * like `components/foo/Bar.vue` work when the project resolves them relative
 * to `src/web/src` rather than the repo root.
 */
function baseDirsFor(absPath: string, cwd: string): string[] {
	const dirs: string[] = [];
	let dir = dirname(absPath);
	dirs.push(dir);

	if (!isInside(cwd, dir)) return dirs;
	while (dir !== cwd) {
		const parent = dirname(dir);
		if (parent === dir) break;
		dirs.push(parent);
		dir = parent;
	}
	return dirs;
}

function registerRef(ref: FileRef, context: RefContext): void {
	context.byBasename.set(basename(ref.absPath), ref.absPath);

	const incoming = baseDirsFor(ref.absPath, context.cwd);
	const incomingSet = new Set(incoming);
	context.bases = [...incoming, ...context.bases.filter((dir) => !incomingSet.has(dir))].slice(0, 48);
}

function resolveTextToken(token: string, line: number, context: RefContext): FileRef | undefined {
	// A bare name such as `Panel.vue` can be matched against files we
	// already know about, regardless of which directory the prose came from.
	if (!token.includes("/")) {
		const known = context.byBasename.get(token);
		if (known) {
			const ref = refFromAbsolute(known, line, "mention", context.cwd, context.fileCache);
			if (ref) return ref;
		}
	}

	// Table cells and code snippets often use paths relative to the file being
	// discussed, or to a project source root rather than the repo root.
	for (const base of context.bases) {
		const ref = refFromAbsolute(
			resolve(base, expandHome(token)),
			line,
			"mention",
			context.cwd,
			context.fileCache,
		);
		if (ref) return ref;
	}
	return undefined;
}

function normalizedGap(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\s,;:.()[\]{}'"`\-–—]+/g, "")
		.trim();
}

/**
 * Find the file a natural-language line reference belongs to. This handles
 * `path, line 12` and `line 12 of path`; otherwise the caller falls back to
 * the first file mentioned in the same text block.
 */
function explicitLineTarget(
	text: string,
	start: number,
	end: number,
	matches: PathMatch[],
): FileRef | undefined {
	const before = [...matches].reverse().find((match) => match.end <= start);
	if (before && start - before.end <= 80) {
		const gap = normalizedGap(text.slice(before.end, start));
		if (gap === "" || gap === "at" || gap === "on" || gap === "in" || gap === "of" || gap === "from") {
			return before.ref;
		}
	}

	const after = matches.find((match) => match.start >= end);
	if (after && after.start - end <= 80) {
		const gap = normalizedGap(text.slice(end, after.start));
		if (gap === "of" || gap === "in" || gap === "from" || gap === "at" || gap === "on") {
			return after.ref;
		}
	}
	return undefined;
}

/** Keep offsets stable while ignoring line references inside fenced code. */
function maskFencedCode(text: string): string {
	return text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
}

/**
 * The agent often writes "Imported at line 12" or "Rendered at line ~106"
 * instead of `path:12`. Attach those numbers to the file the paragraph is
 * about (the first path in the block), unless an explicit path is adjacent.
 */
function scanNaturalLineRefs(
	text: string,
	context: RefContext,
	matches: PathMatch[],
	subject: FileRef | undefined,
): FileRef[] {
	const refs: FileRef[] = [];
	const masked = maskFencedCode(text);
	const usedRanges: Array<[number, number]> = [];

	const addLineRef = (number: number, start: number, end: number, allowSubject: boolean): void => {
		const line = Math.floor(number);
		if (!Number.isFinite(line) || line < 1) return;

		const target = explicitLineTarget(masked, start, end, matches) ?? (allowSubject ? subject : undefined);
		if (!target) return;

		const ref = refFromAbsolute(target.absPath, line, "mention", context.cwd, context.fileCache);
		if (!ref) return;
		refs.push(ref);
		registerRef(ref, context);
	};

	// "at line 12", "at line ~106", "on lines 12-15"
	const withPreposition = /\b(?:at|on|around|near|from|to)\s+lines?\s*~?\s*(\d+)(?:\s*(?:-|–|to)\s*~?\s*(\d+))?/gi;
	let match: RegExpExecArray | null;
	while ((match = withPreposition.exec(masked)) !== null) {
		addLineRef(Number(match[1]), match.index, withPreposition.lastIndex, true);
		usedRanges.push([match.index, withPreposition.lastIndex]);
	}

	// "path, line 12" / "path line 12" only when a path is explicitly nearby.
	const bare = /(?:^|[\s,;:(])lines?\s*~?\s*(\d+)(?:\s*(?:-|–|to)\s*~?\s*(\d+))?/gi;
	while ((match = bare.exec(masked)) !== null) {
		const start = match.index;
		const end = bare.lastIndex;
		if (usedRanges.some(([usedStart, usedEnd]) => start < usedEnd && end > usedStart)) continue;
		addLineRef(Number(match[1]), start, end, false);
	}

	return refs;
}

/**
 * Pick `path:line`-looking tokens out of prose. Resolution against known
 * base directories filters out URLs, version numbers, and other false positives.
 */
function scanTextRefs(text: string, context: RefContext): FileRef[] {
	const refs: FileRef[] = [];
	const matches: PathMatch[] = [];
	const re =
		/(?:^|[\s`'"([{<|])((?:~|\.{1,2}\/|\/)?[A-Za-z0-9_.@%+\-/]+\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+))?(?::\d+)?/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const token = match[1].replace(/^@/, "").replace(/[.,;:]+$/, "");
		if (!token || token.includes("://") || /^https?$/i.test(token)) continue;
		const ref = resolveTextToken(token, match[2] ? Number(match[2]) : 1, context);
		if (ref) {
			const start = match.index + match[0].indexOf(match[1]);
			matches.push({ ref, start, end: start + match[1].length });
			refs.push(ref);
			registerRef(ref, context);
		}
	}

	refs.push(...scanNaturalLineRefs(text, context, matches, matches[0]?.ref));
	return refs;
}

/**
 * Tool results often contain the full paths that assistant prose abbreviates,
 * e.g. `src/web/src/...` in an rg result and `src/...` in the answer.
 * Observe those paths for their base directories without adding every result
 * line to the picker.
 */
function observePathText(text: string, context: RefContext): void {
	const re =
		/(?:^|[\s`'"([{<|])((?:~|\.{1,2}\/|\/)?[A-Za-z0-9_.@%+\-/]+\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+))?(?::\d+)?/g;
	let match: RegExpExecArray | null;
	let observed = 0;
	let attempts = 0;
	// Cap attempts as well as hits: large rg/ls/log outputs are mostly tokens
	// that never resolve, and each one costs a stat per candidate base dir.
	while (
		(match = re.exec(text)) !== null &&
		observed < MAX_OBSERVED_PATHS &&
		attempts < MAX_OBSERVED_TOKENS
	) {
		const token = match[1].replace(/^@/, "").replace(/[.,;:]+$/, "");
		if (!token || token.includes("://") || /^https?$/i.test(token)) continue;
		attempts++;
		const ref = resolveTextToken(token, match[2] ? Number(match[2]) : 1, context);
		if (!ref) continue;
		registerRef(ref, context);
		observed++;
	}
}

function collectRefs(ctx: ExtensionContext): FileRef[] {
	const refs: FileRef[] = [];
	const callRefs = new Map<string, FileRef>();
	const context: RefContext = {
		cwd: ctx.cwd,
		bases: [ctx.cwd],
		byBasename: new Map(),
		fileCache: new Map(),
	};

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			content?: unknown;
			details?: unknown;
			toolName?: string;
			toolCallId?: string;
		};

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const rawBlock of message.content) {
				if (!rawBlock || typeof rawBlock !== "object") continue;
				const block = rawBlock as {
					type?: string;
					text?: string;
					name?: string;
					id?: string;
					arguments?: Record<string, unknown>;
				};

				if (block.type === "toolCall" && block.name && SOURCE_TOOLS.has(block.name)) {
					const args = block.arguments ?? {};
					if (typeof args.path !== "string") continue;
					const offset = typeof args.offset === "number" ? args.offset : 1;
					const ref = makeToolRef(
						args.path,
						block.name === "read" ? offset : 1,
						block.name as RefSource,
						ctx.cwd,
						context.fileCache,
					);
					if (ref) {
						refs.push(ref);
						registerRef(ref, context);
						if (block.id) callRefs.set(block.id, ref);
					}
				} else if (block.type === "text" && typeof block.text === "string") {
					refs.push(...scanTextRefs(block.text, context));
				}
			}
		} else if (message.role === "toolResult") {
			if (typeof message.content === "string") {
				observePathText(message.content, context);
			} else if (Array.isArray(message.content)) {
				for (const rawBlock of message.content) {
					if (!rawBlock || typeof rawBlock !== "object") continue;
					const block = rawBlock as { type?: string; text?: string };
					if (block.type === "text" && typeof block.text === "string") {
						observePathText(block.text, context);
					}
				}
			}

			if (message.toolName === "edit" && message.toolCallId) {
				const ref = callRefs.get(message.toolCallId);
				if (!ref) continue;
				const details = message.details as { firstChangedLine?: unknown } | undefined;
				const changedLine = details?.firstChangedLine;
				if (typeof changedLine === "number" && changedLine > 0) {
					ref.line = Math.floor(changedLine);
					ref.source = "edit";
				}
			}
		}
	}

	const unique: FileRef[] = [];
	const seen = new Set<string>();
	for (let i = refs.length - 1; i >= 0 && unique.length < MAX_REFS; i--) {
		const ref = refs[i];
		const key = `${ref.absPath}\0${ref.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(ref);
	}

	// If prose gave us specific line numbers, drop the generic line-1 mention
	// for that file so the picker does not show a less useful duplicate.
	const specificMentionPaths = new Set(
		unique.filter((ref) => ref.source === "mention" && ref.line > 1).map((ref) => ref.absPath),
	);
	return unique.filter(
		(ref) => !(ref.source === "mention" && ref.line === 1 && specificMentionPaths.has(ref.absPath)),
	);
}

function parseTarget(input: string, cwd: string): FileRef | undefined {
	const trimmed = input.trim();
	const match = /^(.*?):(\d+)(?::\d+)?$/.exec(trimmed);
	const pathPart = match?.[1] ?? trimmed;
	const line = match?.[2] ? Number(match[2]) : 1;
	return makeRef(pathPart, line, "peek", cwd);
}

async function readHead(absPath: string, maxBytes: number): Promise<string> {
	const handle = await open(absPath, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

async function loadFile(absPath: string): Promise<LoadedFile> {
	const info = await stat(absPath);
	if (!info.isFile()) throw new Error("Not a regular file");

	let content: string;
	let truncated = false;
	if (info.size > MAX_FILE_BYTES) {
		content = await readHead(absPath, MAX_FILE_BYTES);
		truncated = true;
	} else {
		content = await readFile(absPath, "utf8");
	}

	if (content.includes("\0")) throw new Error("Binary file");
	content = content.replace(/\r\n?/g, "\n");
	if (truncated) {
		const lastNewline = content.lastIndexOf("\n");
		if (lastNewline > 0) content = content.slice(0, lastNewline);
	}

	let rawLines = content.split("\n");
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
	if (rawLines.length > MAX_FILE_LINES) {
		rawLines = rawLines.slice(0, MAX_FILE_LINES);
		truncated = true;
	}
	rawLines = rawLines.map((line) => replaceControlCharacters(line.replace(/\t/g, "    ")));

	return {
		rawLines,
		language: languageForPath(absPath),
		truncated,
	};
}

function languageForPath(absPath: string): string | undefined {
	const detected = getLanguageFromPath(absPath);
	if (detected) return detected;

	// Pi's language map does not know component formats. The HTML grammar still
	// gives useful highlighting for tags, attributes, and embedded script/style.
	switch (extname(absPath).toLowerCase()) {
		case ".vue":
		case ".svelte":
		case ".astro":
			return "html";
		default:
			return undefined;
	}
}

/**
 * Split an editor command line into argv the way a POSIX shell would for the
 * simple cases: whitespace separates words, '...' is literal, "..." allows
 * backslash escapes of " and \, and a backslash outside quotes escapes the
 * next whitespace, quote, or backslash. Other backslashes are kept as-is so
 * Windows paths survive. No variable expansion or globbing.
 */
function splitCommandLine(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else current += ch;
			continue;
		}

		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
			} else if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
				current += input[++i];
			} else {
				current += ch;
			}
			continue;
		}

		if (/\s/.test(ch)) {
			if (inWord) {
				words.push(current);
				current = "";
				inWord = false;
			}
			continue;
		}

		inWord = true;
		if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (ch === "\\" && i + 1 < input.length && /[\s'"\\]/.test(input[i + 1])) {
			current += input[++i];
		} else {
			current += ch;
		}
	}

	// An unterminated quote just runs to the end of the string.
	if (inWord) words.push(current);
	return words;
}

function editorSpec(absPath: string, line: number): { command: string; args: string[] } {
	const raw = (process.env.FILE_PEEK_EDITOR || process.env.VISUAL || process.env.EDITOR || "vim").trim();
	const parts = splitCommandLine(raw);
	const command = parts[0] || "vim";
	const baseArgs = parts.slice(1);
	const name = basename(command).toLowerCase();

	if (name === "code" || name === "code-insiders" || name === "codium") {
		return { command, args: [...baseArgs, "--goto", `${absPath}:${line}`] };
	}
	if (name === "hx" || name === "helix") {
		return { command, args: [...baseArgs, `${absPath}:${line}`] };
	}
	return { command, args: [...baseArgs, `+${line}`, absPath] };
}

async function runEditor(ctx: ExtensionContext, absPath: string, line: number): Promise<boolean> {
	const spec = editorSpec(absPath, line);
	let error: string | undefined;

	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		try {
			const result = spawnSync(spec.command, spec.args, {
				cwd: ctx.cwd,
				env: process.env,
				stdio: "inherit",
			});
			if (result.error) error = result.error.message;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		} finally {
			tui.start();
			tui.requestRender(true);
		}
		done(undefined);
		return { render: () => [], invalidate() {} };
	});

	if (error) {
		ctx.ui.notify(`Could not open ${spec.command}: ${error}`, "error");
		return false;
	}
	return true;
}

class FilePeekView implements Component {
	private tui: TUI;
	private theme: Theme;
	private target: FileRef;
	private file: LoadedFile;
	private done: (result: ViewResult) => void;

	private cursor = 0;
	private top = 0;
	private left = 0;
	private maxWidth = 1;
	private highlighted: string[] = [];
	private cachedKey = "";
	private cachedLines: string[] = [];

	constructor(
		tui: TUI,
		theme: Theme,
		target: FileRef,
		file: LoadedFile,
		done: (result: ViewResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.target = target;
		this.file = file;
		this.done = done;
		this.cursor = Math.max(0, Math.min(file.rawLines.length - 1, target.line - 1));
		this.top = Math.max(0, this.cursor - 3);
		this.highlight();
	}

	private highlight(): void {
		const source = this.file.rawLines;
		if (source.length === 0) {
			this.highlighted = [];
			this.maxWidth = 1;
			return;
		}

		const lines = highlightCode(source.join("\n"), this.file.language).slice(0, source.length);
		while (lines.length < source.length) lines.push("");
		this.highlighted = lines;

		let maxWidth = 1;
		for (const line of source) maxWidth = Math.max(maxWidth, visibleWidth(line));
		this.maxWidth = maxWidth;
	}

	private contentHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(4, Math.min(32, rows - 6));
	}

	private ensureVisible(height: number): void {
		const count = this.file.rawLines.length;
		if (count === 0) {
			this.cursor = 0;
			this.top = 0;
			return;
		}
		this.cursor = Math.max(0, Math.min(count - 1, this.cursor));
		const maxTop = Math.max(0, count - height);
		this.top = Math.max(0, Math.min(maxTop, this.top));
		if (this.cursor < this.top) this.top = this.cursor;
		if (this.cursor >= this.top + height) this.top = this.cursor - height + 1;
		this.top = Math.max(0, Math.min(maxTop, this.top));
	}

	private header(width: number): string {
		const total = this.file.rawLines.length;
		const current = total === 0 ? 0 : this.cursor + 1;
		const left = ` ${this.theme.bold(this.theme.fg("accent", "peek"))} ${this.theme.fg(
			"text",
			this.target.displayPath,
		)}${this.theme.fg("dim", `:${current}`)}${
			this.file.truncated ? this.theme.fg("warning", "  (partial)") : ""
		}`;
		const right = this.theme.fg("dim", `${current}/${total} `);
		const gap = width - visibleWidth(left) - visibleWidth(right);
		const line = gap > 0 ? left + " ".repeat(gap) + right : left;
		return this.theme.bg("selectedBg", truncateToWidth(line, width, "", true));
	}

	private footer(width: number): string {
		const help = " enter/e edit · q close · j/k scroll · PgUp/PgDn · g/G · h/l pan ";
		return this.theme.bg("toolPendingBg", truncateToWidth(this.theme.fg("dim", help), width, "", true));
	}

	private codeLine(index: number, gutterWidth: number, codeWidth: number, width: number): string {
		const isCursor = index === this.cursor;
		const marker = isCursor ? this.theme.fg("accent", "▌") : " ";
		const number = this.theme.fg(isCursor ? "accent" : "dim", String(index + 1).padStart(gutterWidth));
		const code = sliceByColumn(this.highlighted[index] ?? "", this.left, codeWidth, true);
		const line = truncateToWidth(` ${marker}${number} ${code}`, width, "", true);
		return this.theme.bg(isCursor ? "selectedBg" : "toolPendingBg", line);
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const height = this.contentHeight();
		this.ensureVisible(height);

		const total = this.file.rawLines.length;
		const gutterWidth = Math.max(1, String(Math.max(1, total)).length);
		const codeWidth = Math.max(1, renderWidth - gutterWidth - 3);
		this.left = Math.max(0, Math.min(this.left, Math.max(0, this.maxWidth - codeWidth)));
		const key = `${renderWidth}:${height}:${this.top}:${this.cursor}:${this.left}`;
		if (this.cachedKey === key) return this.cachedLines;
		const lines: string[] = [this.header(renderWidth)];

		if (total === 0) {
			const empty = this.theme.fg("dim", " (empty file)");
			lines.push(this.theme.bg("toolPendingBg", truncateToWidth(empty, renderWidth, "", true)));
			for (let i = 1; i < height; i++) {
				lines.push(this.theme.bg("toolPendingBg", " ".repeat(renderWidth)));
			}
		} else {
			for (let row = 0; row < height; row++) {
				const index = this.top + row;
				if (index < total) {
					lines.push(this.codeLine(index, gutterWidth, codeWidth, renderWidth));
				} else {
					lines.push(this.theme.bg("toolPendingBg", " ".repeat(renderWidth)));
				}
			}
		}

		lines.push(this.footer(renderWidth));
		this.cachedKey = key;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
		const printable = printableKey(data);

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || printable === "q") {
			this.done({ action: "close" });
			return;
		}
		if (matchesKey(data, "enter") || printable === "e") {
			const total = this.file.rawLines.length;
			this.done({ action: "edit", line: total === 0 ? 1 : this.cursor + 1 });
			return;
		}

		let handled = true;
		if (matchesKey(data, "down") || printable === "j") {
			this.cursor++;
		} else if (matchesKey(data, "up") || printable === "k") {
			this.cursor--;
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d") || printable === "f" || printable === " ") {
			this.cursor += Math.max(1, Math.floor(this.contentHeight() / 2));
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u") || printable === "b") {
			this.cursor -= Math.max(1, Math.floor(this.contentHeight() / 2));
		} else if (matchesKey(data, "home") || printable === "g") {
			this.cursor = 0;
		} else if (matchesKey(data, "end") || printable === "G") {
			this.cursor = Math.max(0, this.file.rawLines.length - 1);
		} else if (matchesKey(data, "left") || printable === "h") {
			this.left = Math.max(0, this.left - 4);
		} else if (matchesKey(data, "right") || printable === "l") {
			this.left = Math.min(Math.max(0, this.maxWidth - 1), this.left + 4);
		} else {
			handled = false;
		}

		if (!handled) return;
		this.cachedKey = "";
		this.tui.requestRender();
	}

	invalidate(): void {
		this.highlight();
		this.cachedKey = "";
		this.cachedLines = [];
	}
}

async function openViewer(ctx: ExtensionContext, initial: FileRef): Promise<void> {
	let line = initial.line;
	let file: LoadedFile;
	try {
		file = await loadFile(initial.absPath);
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		ctx.ui.notify(`Cannot peek ${initial.displayPath}: ${message}`, "error");
		return;
	}

	while (true) {
		const target: FileRef = { ...initial, line };
		const result = await ctx.ui.custom<ViewResult>(
			(tui, theme, _keybindings, done) => new FilePeekView(tui, theme, target, file, done),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "92%",
					maxHeight: "92%",
					margin: 1,
				},
			},
		);

		if (!result || result.action === "close") return;

		// Remember the selected line first so the viewer reopens there whether or
		// not the editor starts.
		line = result.line ?? line;
		const edited = await runEditor(ctx, initial.absPath, line);
		if (!edited) {
			// The editor failed to start; keep the viewer open at the same place.
			continue;
		}

		try {
			file = await loadFile(initial.absPath);
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : String(caught);
			ctx.ui.notify(`Cannot reopen ${initial.displayPath}: ${message}`, "error");
			return;
		}
	}
}

function formatRef(ref: FileRef): string {
	return `${ref.displayPath}:${ref.line}  · ${ref.source}`;
}

async function openPicker(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("peek requires interactive mode", "error");
		return;
	}

	const refs = collectRefs(ctx);
	if (refs.length === 0) {
		ctx.ui.notify("No file references found in this session yet.", "info");
		return;
	}
	if (refs.length === 1) {
		await openViewer(ctx, refs[0]);
		return;
	}

	const labels = refs.map(formatRef);
	const choice = await ctx.ui.select("Peek file", labels);
	if (!choice) return;
	const index = labels.indexOf(choice);
	if (index >= 0) await openViewer(ctx, refs[index]);
}

export default function filePeekExtension(pi: ExtensionAPI) {
	pi.registerCommand("peek", {
		description: "Browse a recently referenced file, then press e to edit it",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("peek requires interactive mode", "error");
				return;
			}

			const input = args.trim();
			if (!input) {
				await openPicker(ctx);
				return;
			}

			if (input === "last") {
				const refs = collectRefs(ctx);
				if (refs.length === 0) {
					ctx.ui.notify("No file references found in this session yet.", "info");
					return;
				}
				await openViewer(ctx, refs[0]);
				return;
			}

			const target = parseTarget(input, ctx.cwd);
			if (!target) {
				ctx.ui.notify(`File not found: ${input}`, "error");
				return;
			}
			await openViewer(ctx, target);
		},
	});

	const shortcut = (process.env.FILE_PEEK_SHORTCUT?.trim() || DEFAULT_SHORTCUT).toLowerCase();
	if (shortcut !== "none" && !isValidShortcut(shortcut)) {
		console.warn(`[file-peek] Ignoring invalid FILE_PEEK_SHORTCUT "${shortcut}"; using ${DEFAULT_SHORTCUT}.`);
	}
	const key = shortcut === "none" || isValidShortcut(shortcut) ? shortcut : DEFAULT_SHORTCUT;
	if (key !== "none") {
		// Pi reports conflicts with built-in bindings at startup.
		pi.registerShortcut(key as KeyId, {
			description: "Peek a recent file reference",
			handler: async (ctx) => {
				await openPicker(ctx);
			},
		});
	}
}
