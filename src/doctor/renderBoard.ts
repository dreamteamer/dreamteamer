import type { Capability } from "./types.ts"
import type { DoctorRow } from "../types.ts"

const GLYPH: Record<DoctorRow["state"], string> = { ok: "✔", warn: "⚠", bad: "✖" }

export function renderBoard(caps: Capability[]): string {
  return caps
    .flatMap(c => [
      `${c.name} — ${c.verdict}`,
      ...c.checks.map(
        k =>
          `  ${GLYPH[k.state]} ${k.label}${k.detail ? `  ${k.detail}` : ""}${k.state !== "ok" && k.fix ? ` — fix: ${k.fix}` : ""}`
      ),
    ])
    .join("\n")
}
