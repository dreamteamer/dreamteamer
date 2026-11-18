import path from "node:path"
import fs from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { Workspace } from "../types.ts"
import { childEnv } from "../lib/childEnv.ts"
import { compile } from "../compile/compile.ts"
import { resolveNpm } from "../lib/npm/resolveNpm.ts"
import { EXIT } from "../lib/consts.ts"
import type { InstallHooks, SpecEntry } from "./types.ts"
import { planNavFragments, type NavPlan } from "../workspace/navFragments.ts"

/** the command line, two folders up from src/install/ in a checkout and from dist/install/ in the package */
const BIN = fileURLToPath(new URL("../../bin/dreamteamer.js", import.meta.url))

// ---- steps 2–4 and 5–6, shared with `dt update` (install one pin later) ----------------------------

/**
 * Steps 2–4: npm on the resolved list (the two files it rewrites copied aside), verify every package
 * resolves at the version asked for, compile (a refusal restores the pre-image and prunes), then the
 * nav fragments of the listed packages judged and merged (cr-dt-008) — inside the same restore, so a
 * fragment placing another module's collection, or a nav.yaml that does not read, undoes the call
 * like a compile refusal. Returns `{ fresh, nav }` (nav: the plan setupAndCommit writes), or `{ code }`.
 *
 * `childCompile` (dt update): this process opened the workspace before npm, and ESM caches an extension's
 * entry and every file it imports by path — so an in-process compile would run the version npm just
 * replaced, blind to a source kind or harness the new one contributes (rnd/issues …dt-update-compiles-with-
 * the-replaced-version-s-extension). The compile then runs in a child, this engine's own `dt compile`; a
 * non-zero exit is a refusal like any other, and `fresh` is only `{ root, pkg }` — the nav plan reads no
 * extension, and activating the cached ones could refuse on a collision the new versions do not have.
 */
export async function npmAndCompile(
  ws: Workspace,
  list: SpecEntry[],
  {
    npm = resolveNpm(),
    open,
    json = false,
    log = console.log,
    hooks = {},
    what = "install",
    ignoreSettings = false,
    childCompile = false,
  }: {
    npm?: string | null
    open?: (at: string) => Promise<Workspace>
    json?: boolean
    log?: (msg: string) => void
    hooks?: InstallHooks
    what?: string
    ignoreSettings?: boolean
    childCompile?: boolean
  } = {}
): Promise<
  { code: number; fresh?: undefined; nav?: undefined } | { code?: undefined; fresh: Workspace; nav: NavPlan }
> {
  const names = list.map(e => e.manifest.name)
  const pkgFile = path.join(ws.root, "package.json"),
    lockFile = path.join(ws.root, "package-lock.json")
  const versionOf = (n: string): string | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ws.root, "node_modules", n, "package.json"), "utf8")).version ?? null
    } catch {
      return null
    }
  }
  // the pre-image: the two files npm rewrites, and the version each named package had (an update replaces one)
  const before = {
    pkg: fs.readFileSync(pkgFile, "utf8"),
    lock: fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf8") : null,
    versions: Object.fromEntries(names.map(n => [n, versionOf(n)])),
  }
  const args = ["install", "--save-exact", "--no-audit", "--no-fund", ...list.map(e => e.spec)]
  log(`▶ npm ${args.join(" ")}`)
  const r = spawnSync(npm, args, {
    cwd: ws.root,
    stdio: json ? ["ignore", 2, 2] : "inherit",
    env: childEnv(),
    timeout: 600_000,
  })
  if (r.status !== 0) {
    console.error(
      `✖ npm exited ${r.status ?? r.error?.message} — package.json and package-lock.json may have changed; run the same command again to resume`
    )
    return { code: EXIT.failed }
  }
  if (hooks.afterNpm) hooks.afterNpm()
  // 3. verify every package in the list resolves, at the version asked for (a folder link at whatever it holds)
  const still = list
    .filter(e => {
      const v = versionOf(e.manifest.name)
      return v === null || (e.kind !== "folder" && v !== e.manifest.version)
    })
    .map(e => e.manifest.name)
  if (still.length) {
    console.error(
      `✖ npm exited 0, but ${still.join(", ")} still do${still.length === 1 ? "es" : ""} not resolve in node_modules at the version asked for`
    )
    return { code: EXIT.failed }
  }
  // 4. compile — a refusal restores the pre-image and prunes
  let compiled = false // a refusal AFTER a compile (the nav fragments) owes the runtime a recompile
  try {
    let fresh: Workspace
    if (childCompile) {
      // --workspace pins the root: a layer under git_modules/ would otherwise be climbed out of to the reader
      const c = spawnSync(process.execPath, [BIN, "--workspace", ws.root, "compile"], {
        cwd: ws.root,
        stdio: json ? ["ignore", 2, 2] : "inherit",
        env: childEnv(),
      })
      if (c.status !== 0) throw new Error(`compile exited ${c.status ?? c.error?.message ?? c.signal}`)
      compiled = true
      // only what the nav plan reads; dt update, the one caller that asks for a child compile, reads `nav` alone
      fresh = { root: ws.root, pkg: JSON.parse(fs.readFileSync(pkgFile, "utf8")) } as Workspace
    } else {
      fresh = await open(ws.root)
      const stdout = console.log
      if (json) console.log = console.error
      try {
        compile(fresh)
        compiled = true
      } finally {
        console.log = stdout
      }
    }
    const nav = planNavFragments(fresh, { names, ignoreSettings })
    return { fresh, nav }
  } catch (e) {
    fs.writeFileSync(pkgFile, before.pkg)
    if (before.lock !== null) fs.writeFileSync(lockFile, before.lock)
    else fs.rmSync(lockFile, { force: true })
    // the packages this call added go, then npm prunes to the restored lockfile; an emptied scope folder goes too
    for (const n of names) {
      fs.rmSync(path.join(ws.root, "node_modules", n), { recursive: true, force: true })
      const scope = path.dirname(path.join(ws.root, "node_modules", n))
      try {
        if (n.startsWith("@") && fs.readdirSync(scope).length === 0) fs.rmdirSync(scope)
      } catch {
        /* not empty, or gone */
      }
    }
    const back = spawnSync(npm, ["install", "--no-audit", "--no-fund"], {
      cwd: ws.root,
      stdio: "ignore",
      env: childEnv(),
      timeout: 600_000,
    })
    // the restore is checked, never assumed: npm's exit, and every package that had a version before the call is at it again
    const notBack = names.filter(n => before.versions[n] && versionOf(n) !== before.versions[n])
    if (back.status !== 0 || notBack.length) {
      console.error(
        `✖ ${what} refused: ${e.message.split("\n")[0]}\n  restore FAILED (npm exited ${back.status ?? back.error?.message})${notBack.length ? `: ${notBack.map(n => `${n} is not back at ${before.versions[n]}`).join(", ")}` : ""} — package.json and package-lock.json were put back; node_modules was NOT: run npm install to bring it back`
      )
      return { code: EXIT.failed }
    }
    // compile succeeded before the refusal, so .dreamteamer and the harness folders hold the refused
    // packages' sources: compile again over the restored node_modules, so the runtime is the pre-image's.
    // In this process even after a child compile: the versions it cached are the restored ones.
    if (compiled) {
      const stdout = console.log
      console.log = () => {}
      try {
        compile(await open(ws.root))
      } catch (e2) {
        console.error(
          `✖ ${what} refused: ${e.message.split("\n")[0]}\n  package.json, package-lock.json and node_modules are as before the call, but the runtime could not be recompiled (${e2.message.split("\n")[0]}) — run dt compile`
        )
        return { code: EXIT.failed }
      } finally {
        console.log = stdout
      }
    }
    console.error(
      `✖ ${what} refused: ${e.message.split("\n")[0]}\n  package.json, package-lock.json and node_modules are as before the call${compiled ? ", and the runtime is compiled from them again" : ""}`
    )
    return { code: EXIT.failed }
  }
}
