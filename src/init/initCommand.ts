import fs from "node:fs"
import path from "node:path"
import { type StdioOptions, spawnSync } from "node:child_process"
import { escapes } from "./escapes.ts"
import { init } from "./init.ts"
import { initFootprint } from "./initFootprint.ts"
import { seedBlock } from "./seedBlock.ts"
import { engineVersion, readManifest } from "../runtime/runtime.ts"
import { RUNTIME_DIR } from "../runtime/consts.ts"
import type { DreamteamerBlock, Flags, Manifest, PackageJson, Workspace } from "../types.ts"
import { childEnv } from "../lib/childEnv.ts"
import { compile } from "../compile/compile.ts"
import { resolveNpm } from "../lib/npm/resolveNpm.ts"
import { satisfies } from "../lib/npm/satisfies.ts"
import { staleness } from "../compile/staleness.ts"

// ---- `dt init` — one command from a folder to a compiled, checked, committed workspace ------------

import { EXACT } from "../lib/npm/exact.ts"

/** A JSON file as `T` (the shape the caller reads), or null when it is absent or does not parse. */
const readJson = <T = PackageJson>(f: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {
    return null
  }
}

/** The links under `rel` (lstat, never descending through one) — compile writes and prunes whole
 *  trees there, so a link anywhere below is a place it writes through. */
function linksUnder(root: string, rel: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const r = path.join(rel, e.name)
    if (e.isSymbolicLink()) out.push(r)
    else if (e.isDirectory()) linksUnder(root, r, out)
  }
  return out
}

// compile's built-in outputs: the runtime and the harness trees it writes AND prunes (harnesses.js)
const OUTPUT_TREES = [
  RUNTIME_DIR,
  ".claude/skills",
  ".claude/agents",
  ".claude/commands",
  ".agents/skills",
  ".cursor/rules",
]

/** Every DIRECTORY link at or under an output tree — the tree's own root included — wherever it points.
 *  ⚠ FAIL CLOSED, not "follow and judge": a link to a folder INSIDE the workspace is harmless as a path
 *  and still hides what is below it (`linksUnder` never descends through a link), so a file link in the
 *  aliased folder carried compile's write outside (third review). Compile makes none of these itself. */
function aliasedOutputDirs(root: string): string[] {
  const isDirLink = (rel: string): boolean => {
    try {
      return fs.lstatSync(path.join(root, rel)).isSymbolicLink() && fs.statSync(path.join(root, rel)).isDirectory()
    } catch {
      return false
    }
  }
  return OUTPUT_TREES.flatMap(t => [t, ...linksUnder(root, t)]).filter(isDirLink)
}

/** Every path `init --ready` may write, as init and compile will compute them — the effective block,
 *  the built-in output trees with every link inside them, the managed-block files the last compile
 *  recorded, and any top-level file-position link (a contributed harness writes its block at the root).
 *  `.env` is exempt: never written here, and a worktree's is a link to its primary by design. A folder
 *  link in an output tree never reaches here — `aliasedOutputDirs` refuses it first. NOT covered: a
 *  nested file a newly installed extension's harness writes that no earlier compile recorded. */
function writeFootprint(root: string, block: DreamteamerBlock, flags: Flags): string[] {
  let prev: Partial<Manifest> = {}
  try {
    prev = readManifest(root) ?? {}
  } catch {
    /* unreadable: the walk below still judges .dreamteamer/ */
  }
  const top = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(e => e.isSymbolicLink() && e.name !== ".env")
    .filter(e => {
      try {
        return !fs.statSync(path.join(root, e.name)).isDirectory()
      } catch {
        return true
      }
    })
    .map(e => e.name)
  return [
    ...new Set(
      [
        ...initFootprint(block, flags),
        "package-lock.json",
        "node_modules",
        "CLAUDE.md",
        "AGENTS.md",
        "GEMINI.md",
        ...(prev["adapter-blocks"] ?? []),
        ...(prev["adapter-outputs"] ?? []),
        ...OUTPUT_TREES,
        ...OUTPUT_TREES.flatMap(t => linksUnder(root, t)),
        ...top,
      ].map(String)
    ),
  ]
}

/**
 * `dt init [--no-git] [--git <url>] [--no-compile] [--from <dir>] [--input k=v]… [--allow <kind>]… [--no-input]`
 * — from a folder (empty, or a cloned preset, or an existing repo) to a workspace that is pinned to the
 * RUNNING engine, compiled, checked, set up as far as its modules' safe actions go, and committed.
 *
 *  - every path it or compile writes is judged BEFORE the first write (links out of the folder, aliased
 *    output trees, a configured path climbing out), as `init --ready` did
 *  - an engine of another version — declared, locked or installed — is the workspace's choice: refused,
 *    never upgraded (`dt update --engine` is the deliberate move)
 *  - npm runs once: `--save-exact dreamteamer@<this version>` from nothing, or a plain `install` that
 *    restores a preset's lockfile and every module it selected; with `--from <dir>` a missing declared
 *    package comes from that folder of tarballs (`npm install --no-save`), so package.json is untouched
 *  - git: no repository → `git init` and one commit of what init wrote; inside one → the same scoped
 *    commit, the operator's staged work untouched; `--no-git` or no git on PATH → written, not committed,
 *    and the last line says so; `--git <url>` adds `origin` and never pushes
 *  - re-running changes nothing: every step re-checks what is already done
 */
export async function initCommand(
  flags: Flags,
  {
    root = process.cwd(),
    open,
    verify,
    npm = resolveNpm(),
    stdio = "inherit",
    log = console.log,
    processEnv = process.env,
    tty = !!(process.stdin.isTTY && process.stdout.isTTY),
    argv = [],
  }: {
    root?: string
    open?: (at: string) => Promise<Workspace>
    verify?: (ws: Workspace) => number | Promise<number>
    npm?: string | null
    stdio?: StdioOptions
    log?: (msg: string) => void
    processEnv?: NodeJS.ProcessEnv
    tty?: boolean
    argv?: string[]
  } = {}
) {
  const want = engineVersion()
  const pkgPath = path.join(root, "package.json")
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : {}
  if (!pkg || typeof pkg !== "object") throw new Error("package.json is not a JSON object — nothing was written")
  // ⚠ EVERY PATH THIS RUN WRITES IS JUDGED BEFORE THE FIRST WRITE. init and compile write through
  // whatever stands at a path, so a `.gitignore` (or `.claude/skills`, or `modules/`) linked out of the
  // folder would have been rewritten wherever it points, and the run would have said ✔. The block is
  // init's OWN merge (`seedBlock`): a safe flag can never hide an unsafe stored value.
  const block = seedBlock(flags, pkg.dreamteamer)
  for (const k of ["workspace_module", "data_path"]) {
    if (block[k] != null && block[k] !== false && typeof block[k] !== "string")
      throw new Error(`dreamteamer.${k} must be a path (got ${JSON.stringify(block[k])}) — nothing was written`)
  }
  const aliased = aliasedOutputDirs(root)
  if (aliased.length)
    throw new Error(
      `${aliased.join(", ")}: a folder link inside compile's output — compile writes through it, so nothing was written. Replace it with a real folder (or remove it; compile regenerates what it holds)`
    )
  const out = writeFootprint(root, block, flags).filter(rel => escapes(root, rel))
  if (out.length)
    throw new Error(
      `${out.join(", ")} ${out.length > 1 ? "resolve" : "resolves"} outside this workspace — init writes there, so nothing was written. Replace the link (or the configured path) with one inside the folder`
    )

  // ⚠ THE DECLARATION, THE LOCKFILE AND THE INSTALLED COPY ARE JUDGED EACH ON ITS OWN. Reading only the
  // installed copy let a package.json still declaring an older engine pass — the next clone installs that one.
  const specs = [
    ...new Set((["dependencies", "devDependencies"] as const).map(k => pkg[k]?.dreamteamer).filter(Boolean)),
  ]
  const locked =
    readJson<{ packages?: Record<string, { version?: string }> }>(path.join(root, "package-lock.json"))?.packages?.[
      "node_modules/dreamteamer"
    ]?.version ?? null
  const installed = () => readJson(path.join(root, "node_modules", "dreamteamer", "package.json"))?.version ?? null
  const upgrade = `init never changes an existing engine — run that version itself (npx dreamteamer@<version> init), or upgrade on purpose: dt update --engine`
  if (specs.length > 1)
    throw new Error(
      `package.json declares dreamteamer twice, differently (${specs.join(" and ")}) — keep one declaration`
    )
  if (specs[0] && (EXACT.test(specs[0]) ? specs[0] !== want : satisfies(want, specs[0]) === false))
    throw new Error(`package.json declares dreamteamer "${specs[0]}", which ${want} is not — ${upgrade}`)
  if (locked && locked !== want)
    throw new Error(`package-lock.json locks dreamteamer ${locked}, not ${want} — ${upgrade}`)
  if (installed() && installed() !== want)
    throw new Error(`node_modules holds dreamteamer ${installed()}, not ${want} — ${upgrade}`)
  const fromDir = flags.from ? path.resolve(root, flags.from as string) : null
  const fail = (why: string): number => {
    log(
      `✖ ${why}\n  the steps after this one did not run — fix it, then run the same command again: every step re-checks what is already done`
    )
    return 1
  }

  // --from: every package this init will need is looked for in the folder BEFORE anything is written —
  // a folder lacking one is refused with the folder untouched (no skeleton, no registry call)
  if (fromDir) {
    const { indexFolder } = await import("../install/indexFolder.ts")
    let index
    try {
      index = indexFolder(fromDir)
    } catch (e) {
      return fail(e.message)
    }
    const pkg0 = readJson(pkgPath) ?? {}
    const declared0 = !!(pkg0.dependencies?.dreamteamer ?? pkg0.devDependencies?.dreamteamer)
    const missing0 = Object.keys({ ...pkg0.dependencies, ...pkg0.devDependencies })
      .sort()
      .filter(d => !fs.existsSync(path.join(root, "node_modules", d, "package.json")))
    for (const n of declared0 ? missing0 : ["dreamteamer", ...missing0]) {
      const hit =
        n === "dreamteamer" ? (index.get("dreamteamer") ?? []).find(c => c.version === want) : (index.get(n) ?? [])[0]
      if (!hit)
        return fail(
          `--from ${fromDir}: no ${n === "dreamteamer" ? `dreamteamer@${want}` : n} in it — nothing was written`
        )
    }
  }
  init({ flags, root, commit: false })
  log(
    "✔ skeleton: the package.json dreamteamer block, the workspace module, .gitignore, .env.example — kept where present"
  )
  // EVERY declared package, not just the engine: a preset whose npm install was interrupted holds the
  // engine and lacks the modules it selected, and compile then succeeds without them (`planInstall`'s lesson).
  const now = () => readJson(pkgPath) ?? {}
  const missing = () =>
    Object.keys({ ...now().dependencies, ...now().devDependencies })
      .sort()
      .filter(d => !fs.existsSync(path.join(root, "node_modules", d, "package.json")))
  const declared = !!(now().dependencies?.dreamteamer ?? now().devDependencies?.dreamteamer)
  let fresh = false
  if (declared && !missing().length) log(`✔ dependencies: dreamteamer@${want} and every declared package installed`)
  else {
    if (!npm) return fail("cannot install — node found, npm not on PATH")
    let args
    if (fromDir) {
      // offline: every missing declared package (the engine too, from nothing) comes from the folder
      const { indexFolder } = await import("../install/indexFolder.ts")
      let index
      try {
        index = indexFolder(fromDir)
      } catch (e) {
        return fail(e.message)
      }
      const need = declared ? missing() : ["dreamteamer", ...missing()]
      const files = []
      for (const n of need) {
        const hit =
          n === "dreamteamer" ? (index.get("dreamteamer") ?? []).find(c => c.version === want) : (index.get(n) ?? [])[0]
        if (!hit)
          return fail(
            `--from ${fromDir}: no ${n === "dreamteamer" ? `dreamteamer@${want}` : n} in it — nothing was installed`
          )
        files.push(hit.file)
      }
      args = declared
        ? ["install", "--no-save", "--no-audit", "--no-fund", ...files]
        : ["install", "--save-exact", "--no-audit", "--no-fund", ...files]
    } else
      args = declared
        ? ["install", "--no-audit", "--no-fund"]
        : ["install", "--save-exact", "--no-audit", "--no-fund", `dreamteamer@${want}`]
    log(
      `▶ dependencies: npm ${args.join(" ")}${missing().length ? ` — missing ${missing().join(", ")}` : ""} — downloads packages and runs their npm lifecycle scripts`
    )
    const r = spawnSync(npm, args, { cwd: root, stdio, env: childEnv(), timeout: 600_000 })
    if (r.status !== 0) return fail(`npm exited ${r.status ?? r.error?.message}`)
    if (missing().length)
      return fail(
        `npm finished, but ${missing().join(", ")} ${missing().length > 1 ? "are" : "is"} still not installed`
      )
    if (installed() !== want)
      return fail(`npm finished, but node_modules/dreamteamer is ${installed() ?? "missing"}, not ${want}`)
    fresh = true
  }
  let ws = null
  let code = 0
  if (flags["no-compile"])
    log("— compile: skipped (--no-compile) — run dt compile before a session reads this workspace")
  else {
    try {
      ws = await open(root)
      const s = staleness(root)
      if (fresh || !s.compiled || s.stale.length) {
        log("▶ compile")
        compile(ws)
      } else log("✔ compile: fresh")
    } catch (e) {
      return fail(`compile: ${e.message.split("\n")[0]}`)
    }
    if (await verify(ws)) return fail("check: the violations above")
    // a preset's modules: the safe part of every unit's setup, exactly as `dt install` runs it
    const { units } = await import("../setup/units.ts")
    const { runUnit } = await import("../setup/runUnit.ts")
    const { fillInputs } = await import("../setup/fillInputs.ts")
    const { parseInputFlags } = await import("../setup/parseInputFlags.ts")
    const { parseAllow } = await import("../setup/parseAllow.ts")
    const { skippedUnits, SetupUsage, unitEnv, droppedKeys } = await import("../setup/setup.ts")
    const { EXIT } = await import("../lib/consts.ts")
    const { fold } = await import("../setup/fold.ts")
    const { ttyIO } = await import("../setup/ttyIO.ts")
    const skipped = new Set(skippedUnits(ws))
    const all = units(ws).filter(u => !skipped.has(u.id))
    if (all.length) {
      const noInput = !!flags["no-input"]
      const term = tty && !noInput ? ttyIO() : null
      try {
        const filled = await fillInputs(all, {
          flags: parseInputFlags(argv),
          env: unitEnv(ws, processEnv),
          tty,
          noInput,
          prompt: term?.prompt ?? null,
          lenient: true,
        })
        for (const text of filled.ignored) log(`⚠ ${text} — ignored`)
        const allow = parseAllow(argv)
        const written = new Map() // one run never lets two units disagree on a key (he3)
        for (const u of all) {
          const r = await runUnit(ws, u, {
            inputs: filled.inputs.get(u.id) ?? {},
            allow,
            tty,
            ask: term?.ask ?? null,
            processEnv,
            drop: droppedKeys(filled.problems, u.id),
            written,
          })
          const problems = filled.problems.filter(m => m.unit === u.id)
          const miss = [
            ...filled.missing.filter(m => m.unit === u.id).map(m => m.id),
            ...problems.filter(m => m.required).map(m => m.id),
          ]
          const f = fold(r.checks, {})
          log(`${f.state === "ready" ? "✔" : "—"} ${u.id}: ${f.state}${f.detail ? ` — ${f.detail}` : ""}`)
          for (const a of r.applied) log(`    ✔ ${a.id}${a.message ? ` — ${a.message}` : ""}`)
          for (const x of r.failed) log(`    ✖ ${x.id} — ${x.message}`)
          if (r.failed.length && code === 0) code = 1 // D57: a failed apply is a failure; the workspace itself stands
          for (const x of problems) log(`    ✖ ${x.id} — ${x.reason}`)
          for (const pnd of r.pending) log(`    … ${pnd.id} (${pnd.why})${pnd.reason ? ` — ${pnd.reason}` : ""}`)
          if (miss.length) {
            log(`    needs input: ${miss.join(", ")} — dt setup ${u.id} --input ${miss[0]}=<value>`)
            code = 3
          }
          if (r.pending.some(p => p.runBy === "owner" || (p.effects ?? []).some(e => e.kind === "account")))
            log(
              `    the owner's step (opens a browser): dt setup ${u.id}${miss.map(n => ` --input ${n}=<value>`).join("")} --authorize`
            )
        }
      } catch (e) {
        if (e instanceof SetupUsage) {
          fail(e.message)
          return EXIT.usage
        }
        throw e
      } finally {
        term?.close()
      }
    }
  }
  // git — a repository, a remote, one scoped commit; never the operator's own staged work
  const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0
  const isRepo = () =>
    hasGit && spawnSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" }).status === 0
  if (flags["no-git"]) log("— git: skipped (--no-git) — `git status` shows what init wrote")
  else if (!hasGit) log("— git: not on PATH — nothing was committed; `git status` shows what init wrote once it is")
  else {
    if (!isRepo()) {
      spawnSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" })
      log("✔ git: repository created (local, no account)")
    }
    if (flags.git) {
      const has = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, stdio: "ignore" }).status === 0
      if (!has) {
        spawnSync("git", ["remote", "add", "origin", flags.git as string], { cwd: root, stdio: "ignore" })
        log(`✔ git: origin → ${flags.git} (never pushed)`)
      } else log("✔ git: origin already set — left as it is")
    }
    const wm = now().dreamteamer?.workspace_module
    const paths = [
      "package.json",
      "package-lock.json",
      ".gitignore",
      ".env.example",
      ".vscode/extensions.json",
      ...(wm
        ? [`modules/${wm}/package.json`, `modules/${wm}/collections/notes.collection.yaml`]
        : ["collections/notes.collection.yaml"]),
    ].filter(rel => fs.existsSync(path.join(root, rel)))
    const r = spawnSync("git", ["add", "--", ...paths], { cwd: root, stdio: "ignore" })
    const c =
      r.status === 0
        ? spawnSync(
            "git",
            [
              "commit",
              "--quiet",
              "-m",
              `dreamteamer: init workspace ${now().name ?? path.basename(root)}`,
              "--",
              ...paths,
            ],
            { cwd: root, encoding: "utf8" }
          )
        : r
    if (c.status === 0) log(`✔ git: committed ${paths.join(", ")}`)
    else if (/nothing to commit|no changes added/.test(`${c.stdout ?? ""}${c.stderr ?? ""}`))
      log("✔ git: nothing new to commit")
    else
      log(
        `⚠ git: commit did not happen (${((c.stderr as string) ?? "").trim().split("\n")[0] || `exit ${c.status}`}) — \`git status\` shows what init wrote`
      )
  }
  if (ws) {
    const { statusLines } = await import("../setup/statusLines.ts")
    const { renderStatusLines } = await import("../setup/renderStatusLines.ts")
    try {
      for (const line of renderStatusLines(statusLines(ws, { processEnv }))) log(line)
    } catch {
      /* status is a courtesy here */
    }
  }
  log(
    `\nready: dreamteamer@${want}${flags["no-compile"] ? " (not compiled)" : ", compiled and checked"}. Next: dt install <package> adds a module; dt status says what works here.`
  )
  return code
}
