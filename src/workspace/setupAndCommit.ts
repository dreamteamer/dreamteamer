import { execFileSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { parseEnvValues } from "../record/parseEnvValues.ts"
import type { Workspace } from "../types.ts"
import { fillInputs } from "./fillInputs.ts"
import { fold } from "./fold.ts"
import { runUnit } from "./runUnit.ts"
import { EXIT, droppedKeys, skippedUnits } from "./setup.ts"
import { ttyIO } from "./ttyIO.ts"
import type { InputFlag, UnitResult } from "./types.ts"
import { units } from "./units.ts"

// ---- the verb -----------------------------------------------------------------------------------

const gitOk = (root: string, args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const gitIgnored = (root: string, rel: string): boolean => gitOk(root, ["check-ignore", "-q", "--", rel])

/**
 * Steps 5–6: the safe part of the named packages' units (inputs filled leniently — npm has written,
 * so a mistyped --input is a named warning, never an abort), then one scoped commit: the two files
 * npm rewrites, .env.example if compile touched it, and every path an applied action reported that
 * git does not ignore. Returns `{ code, results, committed, ignored }`.
 */
export async function setupAndCommit(
  ws: Workspace,
  fresh: Workspace,
  names: string[],
  {
    subject,
    inputFlags = [],
    allow = new Set(),
    tty = false,
    noInput = true,
    io = null,
    processEnv = process.env,
    noCommit = false,
  }: {
    subject?: string
    inputFlags?: InputFlag[]
    allow?: Set<string>
    tty?: boolean
    noInput?: boolean
    io?: ReturnType<typeof ttyIO> | null
    processEnv?: NodeJS.ProcessEnv
    noCommit?: boolean
  } = {}
): Promise<{ code: number; results: UnitResult[]; committed: string[] | null; ignored: string[] }> {
  const skipped = new Set(skippedUnits(fresh))
  const fresh_units = units(fresh).filter(u => names.includes(u.module) && !skipped.has(u.id))
  let code: number = EXIT.done
  const results: UnitResult[] = []
  let ignored: string[] = []
  if (fresh_units.length) {
    const term = tty && !noInput && !io ? ttyIO() : null
    try {
      const filled = await fillInputs(fresh_units, {
        flags: inputFlags,
        env: { ...dotenv(fresh), ...processEnv },
        tty,
        noInput,
        prompt: io?.prompt ?? term?.prompt ?? null,
        lenient: true,
      })
      ignored = filled.ignored
      const written = new Map<string, { unit: string; value: unknown }>() // one run never lets two units disagree on a key (he3)
      for (const u of fresh_units) {
        const res = await runUnit(fresh, u, {
          inputs: filled.inputs.get(u.id) ?? {},
          allow,
          tty,
          ask: io?.ask ?? term?.ask ?? null,
          authorize: false,
          verify: false,
          processEnv,
          drop: droppedKeys(filled.problems, u.id),
          written,
        })
        const problems = filled.problems.filter(m => m.unit === u.id)
        const missing = [
          ...filled.missing.filter(m => m.unit === u.id).map(m => m.id),
          ...problems.filter(m => m.required).map(m => m.id),
        ]
        const f = fold(
          res.failed.length
            ? [...res.checks, ...res.failed.map(x => ({ id: x.id, status: "blocked", title: x.id, detail: x.message }))]
            : res.checks,
          {}
        )
        results.push({
          id: u.id,
          module: u.module,
          ...f,
          applied: res.applied,
          pending: res.pending,
          failed: res.failed,
          problems,
          needs: [...new Set([...missing, ...res.needs])],
        })
        if (missing.length) code = Math.max(code, EXIT.needsInput)
        else if (res.failed.length && code === EXIT.done) code = EXIT.failed // D57: a failed apply is a failure; the install itself stands and is committed
      }
    } finally {
      term?.close()
    }
  }
  let committed: string[] | null = null
  if (!noCommit && gitOk(ws.root, ["rev-parse", "--git-dir"])) {
    const changed = results
      .flatMap(r => r.applied.flatMap(a => a.changed ?? []))
      .map(p => path.relative(ws.root, path.resolve(ws.root, p)))
      .filter(
        rel =>
          rel &&
          !rel.startsWith("..") &&
          !path.isAbsolute(rel) &&
          fs.existsSync(path.join(ws.root, rel)) &&
          !gitIgnored(ws.root, rel)
      )
    const paths = [...new Set(["package.json", "package-lock.json", ".env.example", ...changed])].filter(rel =>
      fs.existsSync(path.join(ws.root, rel))
    )
    if (gitOk(ws.root, ["add", "--", ...paths]) && gitOk(ws.root, ["commit", "--quiet", "-m", subject, "--", ...paths]))
      committed = paths
  }
  return { code, results, committed, ignored }
}

const dotenv = (ws: Workspace): Record<string, string> => {
  const file = path.join(ws.root, ".env")
  return fs.existsSync(file) ? Object.fromEntries(parseEnvValues(fs.readFileSync(file, "utf8"))) : {}
}
