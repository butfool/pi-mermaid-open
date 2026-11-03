import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { diagramKind, render as renderNativeMermaid } from "grok-mermaid"
import { CancellableLoader } from "@earendil-works/pi-tui"
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent"

type TextBlock = {
  type: "text"
  text: string
}

type AssistantMessage = {
  role: "assistant"
  content: unknown
}

type MessageEntry = {
  type: "message"
  id: string
  message: unknown
}

type MermaidFenceLanguage = "mermaid" | "mmd"

type NativeMermaidMode = "off" | "final" | "streaming"

type NativeStatus =
  | { kind: "rendered"; width: number }
  | { kind: "skipped"; reason: SkipReason }

type SkipReason =
  | { kind: "disabled" }
  | { kind: "mmd-fence" }
  | { kind: "unsupported" }
  | { kind: "invalid" }
  | { kind: "too-wide"; width: number; availableWidth: number }
  | { kind: "warnings" }

type MermaidDiagram = {
  source: string
  diagramType: string
  label: string
  fenceLanguage: MermaidFenceLanguage
  messageOffset: number
  discoveredIndex: number
  nativeStatus: NativeStatus
}

type NativeMermaidConfig = {
  mode: NativeMermaidMode
  availableWidth: number
}

type PiSettings = {
  outputPad?: 0 | 1
  markdown?: {
    mermaid?: NativeMermaidMode
  }
}

const execFileAsync = promisify(execFile)
// Rendered PNGs live in the system temporary directory, which the operating system
// reclaims on its own schedule: macOS prunes /tmp entries that have not been touched
// for three days. No retention logic belongs here.
const OUTPUT_DIR =
  os.platform() === "win32"
    ? path.join(os.tmpdir(), "pi", "mermaid")
    : "/tmp/pi/mermaid"
// Fences must open at the start of a line so that inline code spans describing a fence
// (for example `` ```mermaid ``) are not mistaken for diagram source.
const MERMAID_FENCE_PATTERN =
  /^ {0,3}(`{3,})[ \t]*(mermaid|mmd)\b[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gim

type MermaidFence = {
  fenceLanguage: MermaidFenceLanguage
  source: string
}

export function extractMermaidFences(text: string): MermaidFence[] {
  const fences: MermaidFence[] = []
  for (const match of text.matchAll(MERMAID_FENCE_PATTERN)) {
    const source = trimOuterBlankLines(match[3] ?? "")
    if (!source) continue
    fences.push({
      fenceLanguage: (match[2] ?? "mermaid").toLowerCase() as MermaidFenceLanguage,
      source,
    })
  }
  return fences
}

function isTextBlock(value: unknown): value is TextBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  )
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    "content" in value
  )
}

function isMessageEntry(value: unknown): value is MessageEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "message" &&
    "id" in value &&
    typeof value.id === "string" &&
    "message" in value
  )
}

function getAssistantText(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n")
}

function trimOuterBlankLines(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift()
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop()
  return lines.join("\n")
}

function classifyDiagram(source: string): string {
  const firstMeaningfulLine = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("%%"))

  return firstMeaningfulLine?.split(/\s+/)[0] ?? "mermaid"
}

function extractTitle(source: string): string | undefined {
  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    const match = /^title\s+(.+)$/i.exec(trimmed)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

function relativeMessageLabel(offset: number): string {
  if (offset === 1) return "latest assistant message"
  return `${offset} assistant messages ago`
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "unnamed"
}

function conciseError(stderr: string, stdout: string): string {
  const text = `${stderr}\n${stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join("\n")
  return text || "Unknown error"
}

function getNativeMermaidMode(settings: PiSettings): NativeMermaidMode {
  const mode = settings.markdown?.mermaid
  return mode === "off" || mode === "final" ? mode : "streaming"
}

async function readNativeMermaidConfig(): Promise<NativeMermaidConfig> {
  let settings: PiSettings = {}
  try {
    settings = JSON.parse(
      await readFile(path.join(getAgentDir(), "settings.json"), "utf8"),
    ) as PiSettings
  } catch {
    // Pi's defaults are streaming Mermaid with one column of output padding.
  }

  const columns = process.stdout.columns ?? 80
  const outputPad = settings.outputPad ?? 1

  return {
    mode: getNativeMermaidMode(settings),
    availableWidth: Math.max(1, columns - outputPad * 2),
  }
}

export function getNativeStatus(
  source: string,
  fenceLanguage: MermaidFenceLanguage,
  config: NativeMermaidConfig,
): NativeStatus {
  if (config.mode === "off")
    return { kind: "skipped", reason: { kind: "disabled" } }
  if (fenceLanguage !== "mermaid") {
    return { kind: "skipped", reason: { kind: "mmd-fence" } }
  }
  if (diagramKind(source) === null) {
    return { kind: "skipped", reason: { kind: "unsupported" } }
  }

  const art = renderNativeMermaid(source)
  if (!art) return { kind: "skipped", reason: { kind: "invalid" } }
  if (art.width > config.availableWidth) {
    return {
      kind: "skipped",
      reason: {
        kind: "too-wide",
        width: art.width,
        availableWidth: config.availableWidth,
      },
    }
  }
  if (art.warnings.length > 0) {
    return { kind: "skipped", reason: { kind: "warnings" } }
  }

  return { kind: "rendered", width: art.width }
}

function discoverDiagrams(
  entries: readonly unknown[],
  nativeConfig: NativeMermaidConfig,
): MermaidDiagram[] {
  const assistantMessages = entries
    .filter(isMessageEntry)
    .map((entry) => entry.message)
    .filter(isAssistantMessage)
    .toReversed()

  const diagrams: MermaidDiagram[] = []

  assistantMessages.forEach((message, messageIndex) => {
    for (const fence of extractMermaidFences(getAssistantText(message))) {
      const { source, fenceLanguage } = fence
      const discoveredIndex = diagrams.length + 1
      const diagramType = classifyDiagram(source)
      const label = extractTitle(source) ?? `${diagramType} ${discoveredIndex}`

      diagrams.push({
        source,
        diagramType,
        label,
        fenceLanguage,
        messageOffset: messageIndex + 1,
        discoveredIndex,
        nativeStatus: getNativeStatus(source, fenceLanguage, nativeConfig),
      })
    }
  })

  return diagrams
}

export function formatNativeStatus(status: NativeStatus): string {
  if (status.kind === "rendered") return `✓ rendered · ${status.width} cols`

  switch (status.reason.kind) {
    case "disabled":
      return "✗ skipped · Mermaid disabled"
    case "mmd-fence":
      return "✗ skipped · mmd fence"
    case "unsupported":
      return "✗ skipped · unsupported"
    case "invalid":
      return "✗ skipped · invalid"
    case "too-wide":
      return `✗ skipped · too wide (${status.reason.width} > ${status.reason.availableWidth})`
    case "warnings":
      return "⚠ skipped · parser warnings"
  }
}

function pickerLabel(diagram: MermaidDiagram): string {
  return [
    formatNativeStatus(diagram.nativeStatus),
    diagram.diagramType,
    diagram.label,
    relativeMessageLabel(diagram.messageOffset),
  ].join(" · ")
}

// The file name carries a hash of the diagram source, so one diagram always maps to
// one path. The viewer application keys its windows by path, which means reopening a
// diagram raises the window that already shows it instead of adding another one.
function mermaidArtifactPath(diagram: MermaidDiagram): string {
  const sourceHash = createHash("sha256")
    .update(diagram.source)
    .digest("hex")
    .slice(0, 8)
  const baseName = [
    slugify(diagram.diagramType),
    slugify(diagram.label),
    sourceHash,
  ].join("-")
  return path.join(OUTPUT_DIR, `${baseName}.png`)
}

function renderTempPath(): string {
  return path.join(OUTPUT_DIR, `.rendering-${randomUUID()}.png`)
}

// Rendering writes a sibling temporary file, because `rename` publishes through the
// directory entry: a viewer watching the path sees a change, and a viewer that still
// holds the previous file keeps working. A byte-identical render is discarded, which
// leaves the published file and its window untouched.
async function publishRenderedPng(
  renderedPath: string,
  pngPath: string,
): Promise<void> {
  if (existsSync(pngPath)) {
    const [rendered, published] = await Promise.all([
      readFile(renderedPath),
      readFile(pngPath),
    ])
    if (rendered.equals(published)) {
      await rm(renderedPath)
      return
    }
  }
  await rename(renderedPath, pngPath)
}

const MMDC_COMMAND = os.platform() === "win32" ? "mmdc.cmd" : "mmdc"
const MMDC_SETUP_HINT =
  "Install mermaid-cli first (brew install mermaid-cli, or npm install -g @mermaid-js/mermaid-cli)"
// Puppeteer provisions its own Chromium on demand, which means a long download
// and a version that drifts with every release. A browser that is already
// installed on the machine is used instead, so a render needs no provisioning.
const SYSTEM_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
]

function mermaidRenderEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PUPPETEER_CHROME_SKIP_DOWNLOAD: "true",
  }
  if (!env["PUPPETEER_EXECUTABLE_PATH"]) {
    const browser = SYSTEM_BROWSERS.find((candidate) => existsSync(candidate))
    if (browser) env["PUPPETEER_EXECUTABLE_PATH"] = browser
  }
  return env
}

async function renderMermaidToPng(
  source: string,
  pngPath: string,
): Promise<{
  ok: boolean
  error?: string
}> {
  try {
    await execFileAsync(MMDC_COMMAND, ["--version"])
  } catch {
    return {
      ok: false,
      error: `${MMDC_COMMAND} is not on PATH. ${MMDC_SETUP_HINT}`,
    }
  }

  return new Promise((resolve) => {
    const child = spawn(
      MMDC_COMMAND,
      ["-i", "-", "-o", pngPath, "--scale", "4"],
      { env: mermaidRenderEnvironment() },
    )

    let stdout = ""
    let stderr = ""

    child.stdout.setEncoding("utf-8")
    child.stderr.setEncoding("utf-8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })

    child.on("error", (error) => {
      resolve({ ok: false, error: error.message })
    })

    child.on("close", (code) => {
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, error: conciseError(stderr, stdout) },
      )
    })

    child.stdin.end(source)
  })
}

async function openPngWithSystemViewer(
  pngPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const platform = os.platform()
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open"
  const args = platform === "win32" ? ["/c", "start", "", pngPath] : [pngPath]

  try {
    await execFileAsync(command, args)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("mermaid-open", {
    description: "Open a skipped Mermaid diagram in the system image viewer",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle()

      const nativeConfig = await readNativeMermaidConfig()
      const diagrams = discoverDiagrams(
        ctx.sessionManager.getBranch(),
        nativeConfig,
      )
      const skippedDiagrams = diagrams.filter(
        (diagram) => diagram.nativeStatus.kind === "skipped",
      )

      if (diagrams.length === 0) {
        ctx.ui.notify(
          "No Mermaid diagrams found in recent assistant messages.",
          "info",
        )
        return
      }
      if (skippedDiagrams.length === 0) {
        ctx.ui.notify("No skipped Mermaid diagrams found.", "info")
        return
      }

      let selected = skippedDiagrams[0]
      if (ctx.mode === "tui" && skippedDiagrams.length > 1) {
        const labels = skippedDiagrams.map(pickerLabel)
        const choice = await ctx.ui.select(
          "Open skipped Mermaid diagram:",
          labels,
        )
        if (!choice) return
        selected = skippedDiagrams[labels.indexOf(choice)]
      }

      if (!selected) return

      await mkdir(OUTPUT_DIR, { recursive: true })
      const pngPath = mermaidArtifactPath(selected)
      const renderedPath = renderTempPath()

      if (ctx.mode === "tui") {
        ctx.ui.setWidget("pi-mermaid-open", (tui, theme) => {
          const color = (text: string) => theme.fg("dim", text)
          return new CancellableLoader(
            tui,
            color,
            color,
            "rendering Mermaid...",
          )
        })
      }

      try {
        const renderResult = await renderMermaidToPng(
          selected.source,
          renderedPath,
        )
        if (!renderResult.ok) {
          if (existsSync(renderedPath)) await rm(renderedPath)
          ctx.ui.notify(
            `Mermaid render failed\nError: ${renderResult.error ?? "Unknown error"}`,
            "error",
          )
          return
        }

        await publishRenderedPng(renderedPath, pngPath)

        if (ctx.mode !== "tui") {
          ctx.ui.notify(`Saved Mermaid PNG: ${pngPath}`, "info")
          return
        }

        const openResult = await openPngWithSystemViewer(pngPath)
        ctx.ui.notify(
          openResult.ok
            ? `Opened Mermaid PNG: ${pngPath}`
            : `Could not open Mermaid PNG\nError: ${openResult.error ?? "Unknown error"}\nPath: ${pngPath}`,
          openResult.ok ? "info" : "error",
        )
      } finally {
        if (ctx.mode === "tui") {
          ctx.ui.setWidget("pi-mermaid-open", undefined)
        }
      }
    },
  })
}
