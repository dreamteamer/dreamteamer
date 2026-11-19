import type { StatusLine } from "./types.ts"

export function renderStatusLines(lines: StatusLine[]): string[] {
  if (!lines.length) return []
  const out = ["setup:"]
  const label = (l: StatusLine): string =>
    l.unit ? (l.grouped ? `${moduleId(l.package)} › ${l.unit}` : l.unit) : moduleId(l.package)
  const width = Math.max(...lines.map(l => label(l).length))
  for (const l of lines) {
    const state = l.state === "no-setup" ? "no setup" : l.state === "no-evidence" ? "no evidence" : l.state
    const verified = l.verified ? ` · verified ${l.verified}` : ""
    out.push(
      `  ${label(l).padEnd(width)}  ${state}${verified}${l.detail ? `   ${l.detail}` : ""}${l.next ? `   → ${l.next}` : ""}`
    )
  }
  return out
}

const moduleId = (name: unknown): string => String(name).replace(/^@[^/]+\//, "")
