# Changelog

## [0.3.2] - 2026-11-03

- Publish through npm trusted publishing, so the release carries a provenance statement.

## [0.3.1] - 2026-11-03

First release of this fork as `@butcool/pi-mermaid-open`.

- Renders with the `mmdc` binary from `PATH`, pointed at an already installed browser, so a render needs no network access.
- Opens the PNG in the system image viewer instead of drawing it inside the terminal.
- Publishes PNGs to `<tmp>/pi/mermaid` under a source-hashed name, so reopening a diagram reuses one path and one viewer window.
- Adds tests for fence extraction, native render status, and status labels.
