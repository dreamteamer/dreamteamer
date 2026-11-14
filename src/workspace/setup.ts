import path from "node:path"
import fs from "node:fs"
import { parseEnvValues } from "./parseEnvValues.ts"
import { RUNTIME_DIR } from "../runtime/consts.ts"
import type { Workspace } from "../types.ts"
import type { InputProblem } from "./types.ts"
import { EXIT } from "./consts.ts"

export class SetupUsage extends Error {
  code: number
  constructor(m: string) {
    super(m)
    this.code = EXIT.usage
  }
}

export const usage = (m: string): SetupUsage => new SetupUsage(m)

export const expandHome = (p: string, home: string): string =>
  typeof p === "string" && (p === "~" || p.startsWith("~/")) ? path.join(home, p.slice(1)) : p

/** The env keys a unit must not see: those whose value the engine refused for it. */
export const droppedKeys = (problems: InputProblem[], unitId: string): string[] => [
  ...new Set(problems.filter(p => p.unit === unitId && p.env).map(p => p.env)),
]

export const skippedUnits = (ws: Workspace): string[] => ws.pkg?.dreamteamer?.setup?.skipped ?? []

export const receiptDir = (ws: Workspace, unitId: string): string => path.join(ws.root, RUNTIME_DIR, "setup", unitId)

/** The environment a unit sees: the process's, with the workspace `.env` filling what it lacks. */
export function unitEnv(ws: Workspace, processEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const file = path.join(ws.root, ".env")
  // a leading byte-order mark would hide the first key from the reader (`^KEY=`) and let a key inside
  // another key's quoted value read as an assignment (held-out he1) — skipped here, the workspace side
  const dotenv = fs.existsSync(file) ? parseEnvValues(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) : new Map()
  return { ...Object.fromEntries(dotenv), ...processEnv }
}
