import { execFileSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import type { Workspace } from "../types.ts"
import { compile } from "../compile/compile.ts"
import { installedModules } from "./installedModules.ts"
import { npmAndCompile } from "./npmAndCompile.ts"
import { npmFloor } from "../lib/npm/npmFloor.ts"
import { parseAllow } from "../setup/parseAllow.ts"
import { parseInputFlags } from "../setup/parseInputFlags.ts"
import { printUnitResults } from "../setup/printUnitResults.ts"
import { resolveClosure } from "./resolveClosure.ts"
import { resolveNpm } from "../lib/npm/resolveNpm.ts"
import { SetupUsage } from "../setup/setup.ts"
import { EXIT } from "../lib/consts.ts"
import { setupAndCommit } from "../setup/setupAndCommit.ts"
import { staleness } from "../compile/staleness.ts"
import type { ttyIO } from "../setup/ttyIO.ts"
import type { InputFlag } from "../setup/types.ts"
import type { InstallHooks } from "./types.ts"
import { InstallRefusal } from "./versions.ts"

/** `git status --porcelain` of one path: '' when clean (modified AND untracked both count as dirty). */
const gitStatus = (root: string, rel: string): string => {
  try {
    return execFileSync("git", ["status", "--porcelain", "--", rel], { cwd: root, encoding: "utf8" }).trim()
  } catch {
    return ""
  }
}

/**
 * `dt install <spec…> [--from <dir>] [--input k=v]… [--allow <kind>]… [--no-input] [--no-commit] [--json]`
 * `hooks.afterNpm` is a test seam the CLI never sets (an interruption between npm and compile).
 */
export async function installModules(
  ws: Workspace,
  argv: string[],
  {
    open,
    npm = resolveNpm(),
    verify = null,
    hooks = {},
    log: logOut = console.log,
    processEnv = process.env,
    tty = !!(process.stdin.isTTY && process.stdout.isTTY),
    io = null,
  }: {
    open?: (at: string) => Promise<Workspace>
    npm?: string | null
    verify?: ((ws: Workspace) => number | Promise<number>) | null
    hooks?: InstallHooks
    log?: (msg: string) => void
    processEnv?: NodeJS.ProcessEnv
    tty?: boolean
    io?: ReturnType<typeof ttyIO> | null
  } = {}
): Promise<number> {
  if (typeof open !== "function")
    throw new Error("installModules: opts.open (an extension-activating opener) is required")
  const json = argv.includes("--json")
  // with --json, stdout is the payload and nothing else: every line of chatter goes to stderr
  const log = json ? console.error : logOut
  const noInput = json || argv.includes("--no-input")
  const noCommit = argv.includes("--no-commit")
  const fromAt = argv.indexOf("--from")
  const from = fromAt > -1 ? path.resolve(ws.root, argv[fromAt + 1] ?? "") : null
  if (fromAt > -1 && !argv[fromAt + 1]) {
    console.error("✖ --from takes a folder of tarballs")
    return EXIT.usage
  }
  const valueFlags = new Set(["--from", "--input", "--allow"])
  const specs = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.has(argv[i - 1]))
  if (!specs.length) {
    console.error("✖ dt install takes one or more specs: a name, name@version, ./file.tgz, ./folder or a git URL")
    return EXIT.usage
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

  const floor = npmFloor(npm)
  if (floor) {
    console.error(`✖ ${floor}`)
    return EXIT.failed
  }

  // 1. resolve and refuse early — nothing is written before step 2
  const installed = installedModules(ws)
  let plan: ReturnType<typeof resolveClosure>
  try {
    plan = resolveClosure(specs, { installed, from, npm, cwd: ws.root })
  } catch (e) {
    if (e instanceof InstallRefusal) {
      console.error(`✖ ${e.message}`)
      return EXIT.failed
    }
    throw e
  }
  const setupOpts = { inputFlags, allow, tty, noInput, io, processEnv, noCommit }
  if (!plan.list.length) {
    // everything is here — but an earlier run cut off anywhere after npm (a kill, a Ctrl-D at a prompt,
    // a refused input) may have left the runtime stale, npm's files uncommitted or the setup unrun;
    // resuming means finishing those steps, never re-running npm. Clean, compiled and no inputs
    // given is nothing to do; inputs given go to the installed units' setup.
    const names = plan.already
    const s = staleness(ws.root)
    const stale = !s.compiled || s.stale.length > 0
    const pending = ["package.json", "package-lock.json", ".env.example"].filter(
      rel => fs.existsSync(path.join(ws.root, rel)) && gitStatus(ws.root, rel) !== ""
    )
    if (!stale && !pending.length && !inputFlags.length) {
      log(`✔ already installed: ${names.join(", ")} — nothing to do`)
      return EXIT.done
    }
    let fresh: Workspace
    try {
      fresh = await open(ws.root)
      if (stale) {
        const stdout = console.log
        if (json) console.log = console.error
        try {
          compile(fresh)
        } finally {
          console.log = stdout
        }
      }
    } catch (e) {
      console.error(`✖ compile: ${e.message.split("\n")[0]}`)
      return EXIT.failed
    }
    const out = await setupAndCommit(ws, fresh, names, {
      subject: `dreamteamer: install ${names.join(", ")}`,
      ...setupOpts,
    })
    const did = [
      stale ? "the stale runtime was compiled" : null,
      out.committed ? `the pending changes were committed (${out.committed.join(", ")})` : null,
      out.results.length ? "the setup ran" : null,
    ].filter(Boolean)
    if (json) {
      logOut(
        JSON.stringify(
          { workspace: { root: ws.root }, installed: [], already: names, committed: out.committed, units: out.results },
          null,
          2
        )
      )
      return out.code
    }
    log(`✔ already installed: ${names.join(", ")} — ${did.join("; ") || "nothing to do"}`)
    printUnitResults(out.results, out.ignored, log)
    return out.code
  }
  const names = plan.list.map(e => e.manifest.name)
  log(
    `▶ install: ${plan.list.map(e => `${e.manifest.name}@${e.manifest.version}${e.kind === "folder" ? " (linked)" : ""}`).join(", ")}${plan.already.length ? ` — already here: ${plan.already.join(", ")}` : ""}`
  )

  // 2–4. npm, verify, compile (a refusal restores the pre-image)
  const step = await npmAndCompile(ws, plan.list, { npm, open, json, log, hooks, what: "install" })
  if (step.code !== undefined) return step.code
  const fresh = step.fresh
  if (verify) {
    const stdout = console.log
    if (json) console.log = console.error
    let bad
    try {
      bad = await verify(fresh)
    } finally {
      console.log = stdout
    }
    if (bad) log("⚠ check reported violations (above) — the install stands; fix the records, or the module's rules")
  }

  // 5–6. the safe part of the new units' setup, one scoped commit
  const out = await setupAndCommit(ws, fresh, names, {
    subject: `dreamteamer: install ${names.join(", ")}`,
    ...setupOpts,
  })
  if (json) {
    logOut(
      JSON.stringify(
        {
          workspace: { root: ws.root },
          installed: names,
          already: plan.already,
          committed: out.committed,
          units: out.results,
        },
        null,
        2
      )
    )
    return out.code
  }
  log(
    `✔ installed ${names.join(", ")} — compiled${out.committed ? `, committed (${out.committed.join(", ")})` : noCommit ? ", not committed (--no-commit)" : ", not committed (not a git repository)"}`
  )
  printUnitResults(out.results, out.ignored, log)
  return out.code
}
