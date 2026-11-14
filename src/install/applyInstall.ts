import { type StdioOptions, spawnSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { declaredDeps } from "./declaredDeps.ts"
import { install as restoreGitModules } from "./install.ts"
import { resolves } from "./resolves.ts"
import type { CheckoutState, InstallStep } from "./types.ts"
import type { Workspace } from "../types.ts"
import { childEnv } from "../lib/childEnv.ts"
import { compile } from "../compile/compile.ts"
import { resolveNpm } from "../lib/npm/resolveNpm.ts"

type StepFn = (
  ws: Workspace,
  st: CheckoutState,
  rel: string | undefined,
  stdio: StdioOptions,
  npm: string | null
) => number

/** Every top-level package in node_modules that is a SYMLINK (scoped ones included), as
 *  `[path, raw link target]` — declared or not: the engine a checkout was cut to test is often an
 *  undeclared link, and it is exactly the one npm's pruning would delete. */
function linkedPackages(root: string): [link: string, target: string][] {
  const nm = path.join(root, "node_modules")
  const out: [string, string][] = []
  const scan = (dir: string): void => {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      if (n.startsWith(".")) continue
      const p = path.join(dir, n)
      let st
      try {
        st = fs.lstatSync(p)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) out.push([p, fs.readlinkSync(p)])
      else if (n.startsWith("@") && dir === nm && st.isDirectory()) scan(p)
    }
  }
  scan(nm)
  return out
}

/** Place a symlink, replacing a dangling one. A step only reaches here because the observer read
 *  the path as absent, which a broken link is — so the leftover has to be cleared, never trusted. */
function placeLink(target: string, at: string): number {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  try {
    if (fs.lstatSync(at).isSymbolicLink()) fs.unlinkSync(at)
  } catch {
    /* nothing there */
  }
  fs.symlinkSync(target, at)
  return 0
}

/** ⚠ EVERY EXECUTOR ANSWERS WITH A CODE, NEVER A THROW. The board's contract is that one failure
 *  names itself and the remaining steps still run — and under `--json` a throw out of here would
 *  abandon the payload as well as the rest of the plan. `compile` throws on a source error, and fs
 *  throws on everything from EACCES to a primary that vanished mid-run, so the guard is the rule
 *  here rather than the exception. */
const guard =
  (name: string, fn: StepFn): StepFn =>
  (...a) => {
    try {
      return fn(...a) ?? 0
    } catch (e) {
      console.error(`✖ ${name}: ${e.message.split("\n")[0]}`)
      return 1
    }
  }

// One executor per step id, keyed by the id's kind. None decides ANYTHING — whether a step runs at
// all was settled by `planInstall`. `stdio` is the caller's, so a `--json` run can send a
// subprocess's chatter to stderr and keep stdout for the payload.
const RUN: Record<string, StepFn> = {
  // ⚠ `npm` ARRIVES AS AN ARGUMENT rather than being resolved here, and that is what makes the
  // refusal below testable at all: with the resolution inlined, deleting the guard left the suite
  // green, because no fixture can make npm unresolvable beside the node running the test.
  dependencies: guard("dependencies", (ws, st, rel, stdio, npm) => {
    // ⚠ THE HONEST BOARD LINE, not a crash. `npm` is missing far more often than `node` is —
    // a hook's `sh` finds neither, and the shim resolves only node — so the step has to say
    // WHICH of the two it could not find. `✖ dependencies:` is prepended by the guard.
    if (!npm) throw new Error("cannot install — node found, npm not on PATH")
    // ⚠ A DELIBERATE DEVELOPMENT LINK SURVIVES. `npm ci` deletes node_modules and `npm install`
    // re-points a linked package at the registry, so a dev engine (or a linked extension) would be
    // silently replaced by the published copy — a checkout running a different engine than the one
    // it was cut to test. Every linked direct dependency is recorded here and put back after npm.
    // ⚠ WORKING links only. A DANGLING one (a moved checkout, a deleted vendor folder) is exactly the
    // broken entry this step exists to repair — restoring it undid npm's repair and failed the install.
    const links = linkedPackages(ws.root).filter(([p]) => resolves(p))
    const status =
      spawnSync(
        npm,
        [
          fs.existsSync(path.join(ws.root, "package-lock.json")) ? "ci" : "install",
          "--prefer-offline",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: ws.root, stdio, env: childEnv(), timeout: 600_000 }
      ).status ?? 1
    for (const [p, target] of links) {
      let same = false
      try {
        same = fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p) === target
      } catch {
        /* gone */
      }
      if (same) continue
      fs.rmSync(p, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.symlinkSync(target, p)
      console.error(`… kept the development link ${path.relative(ws.root, p)} → ${target}`)
    }
    if (status !== 0) return status
    // ⚠ npm's exit code is not the answer: a `file:` dependency whose folder does not exist is
    // "added" as a DANGLING link at exit 0. Ready means every declared package now resolves.
    const still = declaredDeps(ws).filter(d => !resolves(path.join(ws.root, "node_modules", d)))
    if (still.length)
      throw new Error(
        `npm exited 0, but ${still.join(", ")} still do${still.length === 1 ? "es" : ""} not resolve in node_modules`
      )
    return 0
  }),
  env: guard(".env", (ws, st) => placeLink(path.join(st.checkout.primary, ".env"), path.join(ws.root, ".env"))),
  asset: guard("asset", (ws, st, rel) => placeLink(path.join(st.checkout.primary, rel), path.join(ws.root, rel))),
  git_modules: guard("git modules", ws => restoreGitModules(ws)),
  compile: guard("compile", ws => compile(ws)), // `ws` is REOPENED first — see applyInstall
  postinstall: guard(
    "postinstall",
    (ws, st, rel, stdio) =>
      spawnSync(st.postinstall, {
        cwd: ws.root,
        shell: true,
        stdio,
        env: { ...childEnv(), DT_PRIMARY: st.checkout.primary },
      }).status ?? 1
  ),
}

/** Print the board and run the todo steps in order. `dryRun` prints and runs nothing. Returns 1 if
 *  any step errored — one failure never abandons the rest, because a checkout half-made-ready with
 *  a named failure is more useful than one that stopped at the first thing it could not do. */
export async function applyInstall(
  ws: Workspace,
  state: CheckoutState,
  steps: InstallStep[],
  {
    dryRun = false,
    log = console.log,
    stdio = "inherit" as StdioOptions,
    npm = resolveNpm(),
    open = null,
  }: {
    dryRun?: boolean
    log?: (line: string) => void
    stdio?: StdioOptions
    npm?: string | null
    open?: ((at: string) => Promise<Workspace>) | null
  } = {}
): Promise<number> {
  let failed = 0,
    installed = false,
    restored = false
  for (const s of steps) {
    // ⚠ NEW PACKAGES ARE NEW SOURCES. The plan judged the runtime fresh BEFORE npm put a module (or an
    // extension) into node_modules, so a compiled workspace that just gained a dependency kept the
    // old runtime at exit 0. Once dependencies were installed, the compile runs whatever the plan said.
    // ⚠ A RESTORED LAYER IS A NEW INPUT TOO: compile bakes a layer's package name and data path into the
    // runtime, and staleness hashes sources only — so a layer the git_modules step just cloned left
    // `✔ compile: fresh` and a runtime that did not know it (the first review of 0.46.0, finding eng-03).
    if (s.id === "compile" && (installed || restored) && s.state === "already")
      Object.assign(s, {
        label: installed ? "compile: dependencies were just installed" : "compile: git modules were just restored",
        state: "todo",
      })
    const glyph = s.state === "todo" ? "▶" : s.state === "already" ? "✔" : "—"
    log(`${glyph} ${s.label}${s.why ? `\n    ${s.why}` : ""}`)
    if (s.state !== "todo" || dryRun) continue
    const [kind, rel] = s.id.split(/:(.+)/)
    // ⚠ COMPILE WITH WHAT WAS JUST INSTALLED. The handle was opened before npm ran, so its
    // extension list predates the packages npm just put in node_modules: a first install compiled an
    // extension's collection as an ordinary one (`storage.base: workspace`) and left the manifest
    // without the provider, and only a second, manual compile repaired it. Reopened here, once.
    if (kind === "compile" && open) {
      try {
        ws = await open(ws.root)
      } catch (e) {
        failed++
        log(`✖ compile: the workspace would not reopen after installing — ${e.message.split("\n")[0]}`)
        continue
      }
    }
    const code = RUN[kind](ws, state, rel, stdio, npm)
    if (code !== 0) {
      failed++
      log(`✖ ${s.id} failed (exit ${code})`)
    } else if (kind === "dependencies") installed = true
    else if (kind === "git_modules") restored = true
  }
  return failed ? 1 : 0
}
