# pi-file-peek

A [pi](https://pi.dev) extension: browse the files the agent has referenced in
the current session without leaving the terminal.

`/peek` collects every file the session's `read`, `edit` and `write` calls
touched, plus paths and line references the assistant mentioned in prose, and
shows the most recent ones in a picker (a single reference opens directly).
Opening one gives a syntax-highlighted, read-only viewer positioned at the
referenced line. Press `e` to open the same file at that line in your real
editor; pi suspends while it runs and reopens the viewer afterwards.

## Install

```bash
pi install git:github.com/inrd/pi-file-peek@v0.1.0
```

Or try it for a single run without touching settings:

```bash
pi -e git:github.com/inrd/pi-file-peek
```

Local checkout:

```bash
pi -e ./extensions/file-peek.ts
```

## Usage

| Command | |
|---|---|
| `/peek` | pick from files referenced in this session |
| `/peek last` | open the most recent reference |
| `/peek path[:line]` | open a file directly (`~/` is expanded) |
| `ctrl+shift+o` | open the recent-reference picker |

### Viewer keys

| Key | |
|---|---|
| `enter` / `e` | open in `$FILE_PEEK_EDITOR` at the selected line |
| `q` / `esc` / `ctrl+c` | close |
| `j` / `k`, `↑` / `↓` | scroll one line |
| `f` / `space`, `b` | half page forward / back |
| `ctrl+d` / `ctrl+u`, `PgDn` / `PgUp` | half page forward / back |
| `g` / `G`, `Home` / `End` | first / last line |
| `h` / `l`, `←` / `→` | pan horizontally |

### Editor selection

The command is taken from `$FILE_PEEK_EDITOR`, then `$VISUAL`, then `$EDITOR`,
then `vim`. Arguments are allowed:

```bash
export FILE_PEEK_EDITOR="code --wait"
```

The value is split like a shell command line, so quote paths or arguments
that contain spaces:

```bash
export FILE_PEEK_EDITOR="'/Applications/My Editor.app/Contents/MacOS/editor' --wait"
```

`code`/`code-insiders`/`codium` are opened with `--goto path:line`, `hx`/`helix`
with `path:line`, everything else with `+line path`. For GUI editors that detach
immediately, add their wait flag (for example `code --wait`) if you want pi to
stay suspended until the window closes.

## What counts as a reference

- `read` tool calls (at the `offset` used), `edit` calls (at the first changed
  line), and `write` calls (at line 1).
- `path:line` and `path` tokens in assistant prose, resolved against the
  session cwd, the file's ancestors and already-seen base directories, so
  alias-style paths and bare filenames work.
- Natural language references such as "at line 12" or "line 12 of `foo.ts`",
  attached to the file the surrounding text is about.
- Paths seen in tool results are observed for their base directories but are
  not added to the picker.

Up to 40 unique references are kept, most recent first.

## Limits

- Interactive (TUI) mode only.
- Files over 1.5 MB or 12,000 lines are shown partially.
- Binary files (containing NUL bytes) are refused.
- `.vue`, `.svelte` and `.astro` files are highlighted with the HTML grammar.

## Development

A single TypeScript file, loaded by pi directly — no build step. Point pi at it
while you work:

```bash
pi -e ./extensions/file-peek.ts
```

After changing it, `/reload` in a running session picks it up.
