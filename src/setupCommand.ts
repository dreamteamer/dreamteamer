import path from "node:path"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import type { PackageJson, SetupContext, Workspace } from "./types.ts"
import { fillInputs } from "./workspace/fillInputs.ts"
import { fold } from "./workspace/fold.ts"
import { parseAllow } from "./workspace/parseAllow.ts"
import { parseInputFlags } from "./workspace/parseInputFlags.ts"
import { runUnit } from "./workspace/runUnit.ts"
import { EXIT, SetupUsage, droppedKeys, skippedUnits, unitEnv } from "./workspace/setup.ts"
import { ttyIO } from "./workspace/ttyIO.ts"
import type { InputFlag, SetupIO, UnitResult } from "./workspace/types.ts"
import { units } from "./workspace/units.ts"

/** Record a skip (or clear one) in package.json → dreamteamer.setup.skipped, keeping the file's own indentation. */
function setSkipped(ws: Workspace, unitId: string, on: boolean): void {
  const file = path.join(ws.root, "package.json")
  const text = fs.readFileSync(file, "utf8")
  const indent = /^\t/m.test(text) ? "\t" : (/^( +)"/m.exec(text)?.[1] ?? "  ")
  const pkg = JSON.parse(text) as PackageJson
  const block = (pkg.dreamteamer ??= {})
  const list = new Set<string>(block.setup?.skipped ?? [])
  if (on) list.add(unitId)
  else list.delete(unitId)
  if (list.size) (block.setup ??= {}).skipped = [...list].sort()
  else if (block.setup) {
    delete block.setup.skipped
    if (!Object.keys(block.setup).length) delete block.setup
  }
  fs.writeFileSync(file, JSON.stringify(pkg, null, indent) + "\n")
  ws.pkg = pkg
  try {
    execFileSync("git", ["add", "--", "package.json"], { cwd: ws.root, stdio: "ignore" })
    execFileSync(
      "git",
      ["commit", "--quiet", "-m", `dreamteamer: ${on ? "skip" : "resume"} setup of ${unitId}`, "--", "package.json"],
      { cwd: ws.root, stdio: "ignore" }
    )
  } catch {
    /* no repo, or nothing to commit — the file is written either way */
  }
}

/**
 * `dt setup [<unit>] [--input k=v]… [--allow <kind>]… [--authorize] [--verify] [--skip] [--no-input] [--json]`
 * Exit: 0 done (pending and blocked steps printed), 1 a unit's apply failed (its blocked line names it — never a crash; D57), 2 usage, 3 a required input missing.
 */
export async function setupCommand(
  ws: Workspace,
  argv: string[],
  {
    processEnv = process.env,
    tty = !!(process.stdin.isTTY && process.stdout.isTTY),
    log = console.log,
    api = null,
    io = null,
  }: {
    processEnv?: NodeJS.ProcessEnv
    tty?: boolean
    log?: (line: string) => void
    api?: SetupContext["dt"]
    io?: SetupIO | null
  } = {}
): Promise<number> {
  const env = unitEnv(ws, processEnv)
  const json = argv.includes("--json")
  const noInput = json || argv.includes("--no-input")
  const flags = {
    authorize: argv.includes("--authorize"),
    verify: argv.includes("--verify"),
    skip: argv.includes("--skip"),
  }
  let allow: Set<string>, inputFlags: InputFlag[]
  try {
    allow = parseAllow(argv)
    inputFlags = parseInputFlags(argv)
  } catch (e) {
    if (e instanceof SetupUsage) {
      console.error(`✖ ${e.message}`)
      return EXIT.usage
    }
    throw e
  }
  const target = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--input" && argv[i - 1] !== "--allow")
  const all = units(ws)
  const chosen = target ? all.filter(u => u.id === target) : all
  if (target && !chosen.length) {
    console.error(`✖ no setup unit "${target}" — installed units: ${all.map(u => u.id).join(", ") || "(none)"}`)
    return EXIT.usage
  }
  if (!all.length) {
    log(
      "— no installed module declares setup — `dt status` lists what is installed, `dt install <package>` adds a module"
    )
    return EXIT.done
  }
  if (flags.authorize && !target) {
    console.error("✖ --authorize takes one unit: dt setup <unit> --authorize")
    return EXIT.usage
  }
  if (flags.authorize && !tty) {
    console.error("✖ --authorize needs a terminal: the owner signs in; a script cannot")
    return EXIT.usage
  }
  if (flags.skip) {
    if (!target) {
      console.error("✖ --skip takes one unit: dt setup <unit> --skip")
      return EXIT.usage
    }
    setSkipped(ws, target, true)
    log(`— ${target}: skipped (dt setup ${target} to resume)`)
    return EXIT.done
  }
  if (target && skippedUnits(ws).includes(target)) {
    setSkipped(ws, target, false)
    log(`✔ ${target}: no longer skipped`)
  }
  const skipped = new Set(skippedUnits(ws))
  const run = chosen.filter(u => !skipped.has(u.id))
  const term = tty && !noInput && !io ? ttyIO() : null
  const prompt = io?.prompt ?? term?.prompt ?? null
  const ask = io?.ask ?? term?.ask ?? null
  let code: number = EXIT.done
  const results: UnitResult[] = []
  try {
    const filled = await fillInputs(run, { flags: inputFlags, env, tty, noInput, prompt })
    const written = new Map<string, { unit: string; value: unknown }>() // the keys this run's env actions wrote, by unit — one run never lets two units disagree on a key
    for (const u of run) {
      const r = await runUnit(ws, u, {
        inputs: filled.inputs.get(u.id) ?? {},
        allow,
        tty,
        ask,
        authorize: flags.authorize,
        verify: flags.verify,
        processEnv,
        api,
        drop: droppedKeys(filled.problems, u.id),
        written,
      })
      const problems = filled.problems.filter(m => m.unit === u.id)
      const missing = [
        ...filled.missing.filter(m => m.unit === u.id).map(m => m.id),
        ...problems.filter(m => m.required).map(m => m.id),
      ]
      const f = fold(
        r.failed.length
          ? [...r.checks, ...r.failed.map(x => ({ id: x.id, status: "blocked", title: x.id, detail: x.message }))]
          : r.checks,
        {}
      )
      results.push({
        id: u.id,
        module: u.module,
        ...f,
        checks: r.checks,
        applied: r.applied,
        pending: r.pending,
        failed: r.failed,
        problems,
        needs: [...new Set([...missing, ...r.needs])],
      })
      if (missing.length) code = Math.max(code, EXIT.needsInput)
      else if (r.failed.length && code === EXIT.done) code = EXIT.failed // D57: an apply that failed is a failure, never a 0
    }
    for (const u of chosen.filter(x => skipped.has(x.id)))
      results.push({
        id: u.id,
        module: u.module,
        ...fold([], { skipped: true }),
        checks: [],
        applied: [],
        pending: [],
        failed: [],
        needs: [],
      })
  } catch (e) {
    if (e instanceof SetupUsage) {
      console.error(`✖ ${e.message}`)
      return EXIT.usage
    }
    throw e
  } finally {
    term?.close()
  }
  if (json) {
    log(JSON.stringify({ workspace: { root: ws.root, name: ws.pkg?.name ?? null }, units: results }, null, 2))
    return code
  }
  for (const r of results) {
    const verified = r.verified ? ` · verified ${r.verified}` : ""
    log(
      `${r.state === "ready" ? "✔" : r.state === "blocked" ? "✖" : "—"} ${r.id}: ${r.state}${verified}${r.detail ? ` — ${r.detail}` : ""}`
    )
    for (const a of r.applied) log(`    ✔ ${a.id}${a.message ? ` — ${a.message}` : ""}`)
    for (const f of r.failed) log(`    ✖ ${f.id} — ${f.message}`)
    for (const p of r.problems ?? []) log(`    ✖ ${p.id} — ${p.reason}`)
    for (const p of r.pending) log(`    … ${p.id} (${p.why})${p.reason ? ` — ${p.reason}` : ""}`)
    if (r.needs.length) log(`    needs input: ${r.needs.join(", ")} — --input ${r.needs[0]}=<value>`)
    if (
      !flags.authorize &&
      (r.pending ?? []).some(p => p.runBy === "owner" || (p.effects ?? []).some(e => e.kind === "account"))
    )
      log(
        `    the owner's step (opens a browser): dt setup ${r.id}${r.needs.map(n => ` --input ${n}=<value>`).join("")} --authorize`
      )
  }
  return code
}
