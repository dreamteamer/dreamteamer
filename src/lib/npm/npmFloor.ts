import { spawnSync } from "node:child_process"
import { childEnv } from "../childEnv.ts"
import { resolveNpm } from "./resolveNpm.ts"
import { satisfies } from "./satisfies.ts"

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const NPM_FLOOR = ">=7.0.0"

/** The npm on PATH is at least NPM_FLOOR, or the refusal naming both. */
export function npmFloor(npm: string | null = resolveNpm()): string | null {
  if (!npm) return "cannot install — node found, npm not on PATH"
  const r = spawnSync(npm, ["--version"], { encoding: "utf8", env: childEnv(), timeout: 30_000 })
  const v = (r.stdout ?? "").trim()
  if (r.status !== 0 || !EXACT.test(v)) return `cannot read npm's version (${r.stderr?.trim() || v || "no output"})`
  return satisfies(v, NPM_FLOOR) === false
    ? `dt install needs npm >=${NPM_FLOOR.slice(2).replace(/\.0\.0$/, "")} (this is ${v}) — npm install -g npm`
    : null
}
