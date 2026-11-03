# @butcool/pi-mermaid-open

Find Mermaid diagrams that Pi left unrendered and open one in the system image viewer.

This is a fork of [`@tifan/pi-mermaid-open`](https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-mermaid-open), maintained at [`butfool/pi-mermaid-open`](https://github.com/butfool/pi-mermaid-open).

## How it works

- Scans assistant messages in the current branch for ` ```mermaid ` and ` ```mmd ` fences.
- Determines what Pi's own Mermaid renderer did with each diagram: rendered, or skipped because Mermaid is disabled, the fence is `mmd`, the diagram type is unsupported, the diagram is too wide for the terminal, the parser reported warnings, or the source is invalid.
- Picks among the skipped diagrams, renders the chosen one as a 4x PNG with the `mmdc` binary, and opens that PNG in the system image viewer.
- Publishes the PNG as `<tmp>/pi/mermaid/<type>-<label>-<source hash>.png`. The hash makes one diagram map to one path, so the viewer raises the window that already shows the diagram instead of adding another one. A byte-identical render leaves the published file untouched, because rendering goes to a sibling temporary file and `rename` publishes it.
- The operating system reclaims the output directory on its own schedule; macOS prunes `/tmp` entries that have not been touched for three days.

## Install

```bash
pi install npm:@butcool/pi-mermaid-open
```

## Requirements

- Pi 1.5.0 or newer.
- `mermaid-cli` available as `mmdc` on `PATH`: `brew install mermaid-cli`, or `npm install -g @mermaid-js/mermaid-cli`. The extension runs that binary directly.
- No network access is needed for a render. When `PUPPETEER_EXECUTABLE_PATH` is unset, an installed Google Chrome, Chromium, Microsoft Edge, or Brave Browser is used, and Puppeteer's browser download stays disabled.
- A desktop session with a default PNG viewer: `open` on macOS, `xdg-open` on Linux, `start` on Windows. Outside TUI mode, and on headless or SSH runs, the PNG is saved and its path is reported.

## Commands

- `/mermaid-open`: pick a skipped Mermaid diagram from recent assistant messages, render it, and open the PNG. A single skipped diagram opens without a picker.

## Differences from upstream

- Rendering runs the `mmdc` binary from `PATH` instead of `bunx -y @mermaid-js/mermaid-cli`. The `bunx` path resolved `@latest` on every run, reinstalled the CLI each time, and pulled the Chromium build the resolved Puppeteer required, so `/mermaid-open` spent its time downloading roughly 50 MB.
- The PNG opens in the system default viewer instead of inside the terminal. The Herdr overlay pane and Pi's in-TUI image viewer were removed: every pan or zoom frame had to travel the Herdr graphics pipeline with the whole image attached, and the placement API only accepts whole-cell offsets.
- PNGs are published to `/tmp/pi/mermaid` (`%TEMP%\pi\mermaid` on Windows) under a source-hashed name instead of to `<agent-dir>/artifacts/mermaid` under a timestamp, so reopening a diagram reuses one path and one window.

## Development

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The tests cover fence extraction, the native render status, and the status labels. Rendering itself needs `mmdc` and a browser, and is exercised by running `/mermaid-open` in a real session.

## Release

Pushing to `main` publishes through npm trusted publishing (OIDC) with provenance; the repository holds no token. A push only publishes when the version in `package.json` is not on the registry yet:

```bash
npm version patch --no-git-tag-version
# update CHANGELOG.md
git commit -am "release: v0.3.2"
git push
```

## License

MIT. Original work copyright (c) 2026 Tifan Dwi Avianto; fork changes copyright (c) 2026 butfool.
