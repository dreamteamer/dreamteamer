import os from "node:os"
import type { SetupCheck, SetupUnit } from "../types.ts"
import { secretPathProblem } from "./lib/secretPathProblem.ts"
import { expandHome } from "./setup.ts"

/**
 * The environment one unit is handed by the read-only verbs (`dt status`, `dt doctor`) — the same rule
 * setup applies: a secret-path the environment holds that is missing, not a file or (posix) readable by
 * others is never handed to the unit, and is reported as its own `missing` row with the fix. Returns
 * `{ env, refused }`; `env` is a copy.
 */
export function unitEnvFor(
  unit: SetupUnit,
  env: Record<string, string>,
  home: string = os.homedir()
): { env: Record<string, string>; refused: SetupCheck[] } {
  const out = { ...env }
  const refused: SetupCheck[] = []
  for (const i of unit.inputs ?? []) {
    if (i.kind !== "secret-path" || !i.env || out[i.env] === undefined || String(out[i.env]).trim() === "") continue
    const problem = secretPathProblem(expandHome(String(out[i.env]), home))
    if (problem) {
      delete out[i.env]
      refused.push({
        id: `${unit.id}.${i.id}`,
        status: "missing",
        title: i.title ?? i.id,
        detail: problem,
        fix: `dt setup ${unit.id} --input ${i.id}=<path>`,
      })
    }
  }
  return { env: out, refused }
}
