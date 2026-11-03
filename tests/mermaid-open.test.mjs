import assert from "node:assert/strict";
import test from "node:test";

import {
  extractMermaidFences,
  formatNativeStatus,
  getNativeStatus,
} from "../src/index.ts";

const config = (mode, availableWidth = 120) => ({ mode, availableWidth });

test("extractMermaidFences collects mermaid and mmd fences", () => {
  const text = [
    "Diagram:",
    "",
    "```mermaid",
    "graph TD",
    "  A --> B",
    "```",
    "",
    "```mmd",
    "sequenceDiagram",
    "  A->>B: hello",
    "```",
  ].join("\n");

  assert.deepEqual(extractMermaidFences(text), [
    { fenceLanguage: "mermaid", source: "graph TD\n  A --> B" },
    { fenceLanguage: "mmd", source: "sequenceDiagram\n  A->>B: hello" },
  ]);
});

test("extractMermaidFences keeps longer fences intact", () => {
  const text = "````mermaid\r\ngraph TD\r\nA-->B\r\n````\r\n";

  assert.deepEqual(extractMermaidFences(text), [
    { fenceLanguage: "mermaid", source: "graph TD\nA-->B" },
  ]);
});

test("extractMermaidFences ignores inline mentions, other languages, and empty fences", () => {
  const text = [
    "Prose that mentions ```mermaid without opening a fence.",
    "",
    "```js",
    "const answer = 42",
    "```",
    "",
    "```mermaid",
    "   ",
    "```",
  ].join("\n");

  assert.deepEqual(extractMermaidFences(text), []);
});

test("getNativeStatus reports diagrams that Pi cannot render natively", () => {
  assert.deepEqual(getNativeStatus("graph TD\nA-->B", "mermaid", config("off")), {
    kind: "skipped",
    reason: { kind: "disabled" },
  });
  assert.deepEqual(getNativeStatus("graph TD\nA-->B", "mmd", config("final")), {
    kind: "skipped",
    reason: { kind: "mmd-fence" },
  });
  assert.deepEqual(
    getNativeStatus("not a diagram at all", "mermaid", config("final")),
    { kind: "skipped", reason: { kind: "unsupported" } },
  );
});

test("getNativeStatus renders a supported diagram that fits", () => {
  const status = getNativeStatus("graph TD\nA-->B", "mermaid", config("final", 200));

  assert.equal(status.kind, "rendered");
  assert.ok(status.kind === "rendered" && status.width > 0);
});

test("getNativeStatus reports diagrams wider than the terminal", () => {
  const status = getNativeStatus("graph TD\nA-->B", "mermaid", config("final", 1));

  assert.equal(status.kind, "skipped");
  assert.equal(status.kind === "skipped" && status.reason.kind, "too-wide");
});

test("formatNativeStatus labels every status", () => {
  assert.equal(formatNativeStatus({ kind: "rendered", width: 42 }), "✓ rendered · 42 cols");
  assert.equal(
    formatNativeStatus({ kind: "skipped", reason: { kind: "disabled" } }),
    "✗ skipped · Mermaid disabled",
  );
  assert.equal(
    formatNativeStatus({ kind: "skipped", reason: { kind: "mmd-fence" } }),
    "✗ skipped · mmd fence",
  );
  assert.equal(
    formatNativeStatus({ kind: "skipped", reason: { kind: "unsupported" } }),
    "✗ skipped · unsupported",
  );
  assert.equal(
    formatNativeStatus({ kind: "skipped", reason: { kind: "invalid" } }),
    "✗ skipped · invalid",
  );
  assert.equal(
    formatNativeStatus({
      kind: "skipped",
      reason: { kind: "too-wide", width: 90, availableWidth: 60 },
    }),
    "✗ skipped · too wide (90 > 60)",
  );
  assert.equal(
    formatNativeStatus({ kind: "skipped", reason: { kind: "warnings" } }),
    "⚠ skipped · parser warnings",
  );
});
