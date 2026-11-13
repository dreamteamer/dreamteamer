// `dt install <spec…>` — bring a module into this workspace: resolve the closure and refuse early,
// npm install --save-exact, verify, compile (and restore on refusal), the safe part of the module's
// setup, one scoped commit. The engine names no module and resolves no version itself: npm resolves
// ranges, and the closure is the presence graph modules already declare (`dreamteamer.dependencies`,
// the key compile enforces for cross-module references). A folder of tarballs (`--from <dir>`) stands
// in for the registry — the offline form candidates and acceptance use.
//
// The other `install` forms — make THIS checkout ready, `--clone`, `repos/<id>`, `--hook` — stay in
// src/checkout.ts and src/init.ts; this file is only the spec form.
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { spawnSync, execFileSync } from "node:child_process"
import { satisfies } from "./semver.ts"
import { engineVersion } from "./runtime.ts"
import { parseEnvValues } from "./env-vars.ts"
import { compile, discoverModules, staleness } from "./compile.ts"
import { resolveNpm, childEnv } from "./checkout.ts"
import {
  units,
  runUnit,
  fillInputs,
  parseInputFlags,
  parseAllow,
  skippedUnits,
  fold,
  SetupUsage,
  EXIT,
  ttyIO,
  droppedKeys,
} from "./setup.ts"
import type { PackageJson, Workspace } from "./types.ts"
/** `hooks.afterNpm` is a test seam the CLI never sets: an interruption between npm and compile */
type InstallHooks = { afterNpm?: () => void | Promise<void> }

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
/** Numeric major.minor.patch order; a prerelease sorts below its release. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[-+]/)[0].split(".").map(Number),
    pb = String(b).split(/[-+]/)[0].split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return (a.includes("-") ? 0 : 1) - (b.includes("-") ? 0 : 1)
}
export const NPM_FLOOR = ">=7.0.0"

export class InstallRefusal extends Error {
  code: number
  constructor(m) {
    super(m)
    this.code = EXIT.failed
  }
}
const refuse = m => new InstallRefusal(m)

// ---- reading manifests ----------------------------------------------------------------------------

/** `package/package.json` out of an npm tarball: gunzip, then walk the ustar headers (512-byte
 *  blocks; the size is octal at offset 124; a `./` prefix is tolerated). No dependency, no shell. */
export function readTarballManifest(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file))
  let at = 0
  while (at + 512 <= buf.length) {
    const name = buf.toString("utf8", at, at + 100).replace(/\0.*$/s, "")
    if (!name) break
    const size = parseInt(
      buf
        .toString("utf8", at + 124, at + 136)
        .replace(/\0.*$/s, "")
        .trim() || "0",
      8
    )
    const type = buf[at + 156]
    const prefix = buf.toString("utf8", at + 345, at + 500).replace(/\0.*$/s, "")
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, "")
    if ((type === 48 || type === 0) && full === "package/package.json")
      return JSON.parse(buf.toString("utf8", at + 512, at + 512 + size))
    at += 512 + Math.ceil(size / 512) * 512
  }
  throw refuse(`${file}: no package/package.json inside the tarball`)
}

/** Every tarball in a folder, indexed by package name, newest first (npm's own semver order via
 *  `satisfies`): file names are never parsed — `npm pack` writes `fix-a-1.0.0.tgz` for `@fix/a`. */
export function indexFolder(dir) {
  const index = new Map()
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw refuse(`--from ${dir}: not a folder`)
  for (const f of fs
    .readdirSync(dir)
    .filter(n => n.endsWith(".tgz"))
    .sort()) {
    const file = path.join(dir, f)
    let m
    try {
      m = readTarballManifest(file)
    } catch {
      continue
    }
    if (!m?.name || !m.version) continue
    ;(index.get(m.name) ?? index.set(m.name, []).get(m.name)).push({ version: m.version, file, manifest: m })
  }
  for (const list of index.values()) list.sort((a, b) => compareVersions(b.version, a.version))
  return index
}

const splitSpec = spec => {
  const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@")
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: null }
}
const isPathSpec = (spec, cwd) =>
  (spec.startsWith(".") || path.isAbsolute(spec) || spec.startsWith("file:")) &&
  fs.existsSync(path.resolve(cwd, spec.replace(/^file:/, "")))

/**
 * One spec → its manifest and the spec npm will be handed. Kinds: `tarball` (a .tgz path, or a name
 * resolved from `--from`), `folder` (a development link), `registry` (a name, read with one
 * `npm view` — the only network call; `github:` and git URLs go the same way).
 */
export function readSpecManifest(spec, { from = null, index = null, npm = resolveNpm(), cwd = process.cwd() } = {}) {
  if (isPathSpec(spec, cwd)) {
    const abs = path.resolve(cwd, spec.replace(/^file:/, ""))
    if (fs.statSync(abs).isDirectory()) {
      const file = path.join(abs, "package.json")
      if (!fs.existsSync(file)) throw refuse(`${spec}: a folder with no package.json`)
      return { kind: "folder", spec: abs, manifest: JSON.parse(fs.readFileSync(file, "utf8")) }
    }
    return { kind: "tarball", spec: abs, manifest: readTarballManifest(abs) }
  }
  const { name, version } = splitSpec(spec)
  if (from) {
    const idx = index ?? indexFolder(from)
    const candidates = idx.get(name) ?? []
    const pick = version ? candidates.find(c => c.version === version) : candidates[0]
    if (!pick)
      throw refuse(
        `no ${version ? `${name}@${version}` : name} in ${from}${candidates.length ? ` (it has ${candidates.map(c => c.version).join(", ")})` : ""}`
      )
    return { kind: "tarball", spec: pick.file, manifest: pick.manifest }
  }
  if (!npm) throw refuse("cannot read the registry — node found, npm not on PATH")
  const r = spawnSync(
    npm,
    ["view", spec, "name", "version", "dreamteamer", "peerDependencies", "dependencies", "--json"],
    { encoding: "utf8", cwd, env: childEnv(), timeout: 120_000 }
  )
  if (r.status !== 0)
    throw refuse(
      `npm view ${spec} failed${
        r.stderr
          ? ` — ${
              r.stderr
                .trim()
                .split("\n")
                .filter(l => /E404|ETARGET|ENOTFOUND|EAI_AGAIN/.test(l))[0] ?? r.stderr.trim().split("\n")[0]
            }`
          : ""
      }`
    )
  let out
  try {
    out = JSON.parse(r.stdout)
  } catch {
    throw refuse(`npm view ${spec}: unreadable answer`)
  }
  const manifest = Array.isArray(out) ? out.at(-1) : out // a range answers with every match; the last is the newest
  if (!manifest?.name) throw refuse(`npm view ${spec}: no such package`)
  return { kind: "registry", spec: `${manifest.name}@${manifest.version}`, manifest }
}

// ---- the closure --------------------------------------------------------------------------------

/** The modules already here, by package name: version, whether it is a development link, its manifest. */
export function installedModules(ws) {
  const out = new Map()
  const { modules } = discoverModules(ws.root, ws.pkg)
  for (const m of modules) {
    let manifest: PackageJson = {}
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(m.root, "package.json"), "utf8"))
    } catch {
      /* a module with no manifest is not a package */
    }
    const name = manifest.name ?? m.name
    let linked = false
    try {
      linked = fs.lstatSync(path.join(ws.root, "node_modules", name)).isSymbolicLink()
    } catch {
      /* not under node_modules */
    }
    out.set(name, { name, version: manifest.version ?? null, linked, manifest, channel: m.channel })
  }
  return out
}

/**
 * Resolve the specs and the closure of their `dreamteamer.dependencies`, and refuse — before npm
 * writes anything — a package that is not a module, an engine floor this engine does not meet, a
 * ring, a version already installed differently, and `provides` conflicts in both directions.
 * Returns the ordered install list (dependencies first) and the names already satisfied.
 */
export function resolveClosure(
  specs,
  {
    installed,
    from = null,
    npm = resolveNpm(),
    cwd = process.cwd(),
    engine = engineVersion(),
  }: {
    installed?: ReturnType<typeof installedModules>
    from?: string | null
    npm?: string | null
    cwd?: string
    engine?: string
  } = {}
) {
  const index = from ? indexFolder(from) : null
  const list = []
  const already = []
  const seen = new Map() // name → entry
  // a package an INSTALLED one already provides: present for the walk (never resolved again), and refused
  // the moment it is asked for by name — before any of its dependencies are looked up anywhere
  const providedBy = name =>
    [...installed].find(([, i]) => (i.manifest?.dreamteamer?.provides ?? []).includes(name))?.[0] ?? null
  const judge = (entry, askedAs, stack = []) => {
    const m = entry.manifest
    if (!m.dreamteamer || typeof m.dreamteamer !== "object")
      throw refuse(
        `${m.name}@${m.version} is not a dreamteamer module (no dreamteamer key in its package.json)${stack.length ? ` — needed by ${stack.at(-1)}` : ""}`
      )
    const provider = providedBy(m.name)
    if (provider) throw refuse(`${provider} already provides ${m.name} — it is installed; nothing to add`)
    const range = m.dreamteamer.engine
    if (range && satisfies(engine, range) === false)
      throw refuse(
        `${m.name}@${m.version} needs engine "${range}" — this is ${engine}; choose a version: dt install ${m.name}@<version>`
      )
    const here = installed.get(m.name)
    if (here?.linked) throw refuse(`${m.name} is a development link (not pinned) — remove the link to pin a version`)
    if (here && here.version && here.version !== m.version && askedAs === "spec")
      throw refuse(
        `${m.name} is installed at ${here.version}, not ${m.version} — move it on purpose: dt update ${m.name}@${m.version}`
      )
  }
  const walk = (spec, stack, askedAs) => {
    // asked for by name and already provided: refuse by name, without reading any manifest
    if (askedAs === "spec" && !isPathSpec(spec, cwd)) {
      const p = providedBy(splitSpec(spec).name)
      if (p) throw refuse(`${p} already provides ${splitSpec(spec).name} — it is installed; nothing to add`)
    }
    const entry = readSpecManifest(spec, { from, index, npm, cwd })
    const name = entry.manifest.name
    if (stack.includes(name))
      throw refuse(`ring in dreamteamer.dependencies: ${[...stack.slice(stack.indexOf(name)), name].join(" → ")}`)
    if (seen.has(name)) {
      // the same module asked for twice at different versions is a conflict, never a silent first-wins
      const prev = seen.get(name).manifest.version
      if (askedAs === "spec" && prev !== entry.manifest.version)
        throw refuse(`${name} is asked for at ${prev} and at ${entry.manifest.version} — one version per call`)
      return
    }
    judge(entry, askedAs, stack)
    const here = installed.get(name)
    if (here && here.version === entry.manifest.version) {
      already.push(name)
      seen.set(name, entry)
      return
    }
    seen.set(name, entry)
    for (const dep of entry.manifest.dreamteamer.dependencies ?? []) {
      if ((installed.has(dep) || providedBy(dep)) && !stack.includes(dep)) continue // present (or composed in): its own closure was judged when it came in
      walk(dep, [...stack, name], "dependency")
    }
    list.push(entry)
  }
  for (const s of specs) walk(s, [], "spec")
  // provides, both ways — against what is installed and within the call itself
  const names = new Set(list.map(e => e.manifest.name))
  for (const e of list) {
    const name = e.manifest.name
    for (const p of e.manifest.dreamteamer.provides ?? []) {
      if (installed.has(p))
        throw refuse(
          `${name} provides ${p}, which is installed — remove ${p} first (npm uninstall ${p}, then dt compile), or keep the small modules`
        )
      if (names.has(p)) throw refuse(`${name} provides ${p} — install one or the other, not both in one call`)
    }
    for (const o of list)
      if (o !== e && (o.manifest.dreamteamer.provides ?? []).includes(name))
        throw refuse(`${o.manifest.name} provides ${name} — install one or the other, not both in one call`)
  }
  return { list, already }
}

/** The npm on PATH is at least NPM_FLOOR, or the refusal naming both. */
export function npmFloor(npm = resolveNpm()) {
  if (!npm) return "cannot install — node found, npm not on PATH"
  const r = spawnSync(npm, ["--version"], { encoding: "utf8", env: childEnv(), timeout: 30_000 })
  const v = (r.stdout ?? "").trim()
  if (r.status !== 0 || !EXACT.test(v)) return `cannot read npm's version (${r.stderr?.trim() || v || "no output"})`
  return satisfies(v, NPM_FLOOR) === false
    ? `dt install needs npm >=${NPM_FLOOR.slice(2).replace(/\.0\.0$/, "")} (this is ${v}) — npm install -g npm`
    : null
}

// ---- the verb -----------------------------------------------------------------------------------

const gitOk = (root, args) => {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}
const gitIgnored = (root, rel) => gitOk(root, ["check-ignore", "-q", "--", rel])
/** `git status --porcelain` of one path: '' when clean (modified AND untracked both count as dirty). */
const gitStatus = (root, rel) => {
  try {
    return execFileSync("git", ["status", "--porcelain", "--", rel], { cwd: root, encoding: "utf8" }).trim()
  } catch {
    return ""
  }
}

// ---- steps 2–4 and 5–6, shared with `dt update` (install one pin later) ----------------------------

/**
 * Steps 2–4: npm on the resolved list (the two files it rewrites copied aside), verify every package
 * resolves at the version asked for, compile (a refusal restores the pre-image and prunes). Returns
 * `{ fresh }`, or `{ code }`.
 */
export async function npmAndCompile(
  ws,
  list,
  {
    npm = resolveNpm(),
    open,
    json = false,
    log = console.log,
    hooks = {},
    what = "install",
  }: {
    npm?: string | null
    open?: (at: string) => Promise<Workspace>
    json?: boolean
    log?: (msg: string) => void
    hooks?: InstallHooks
    what?: string
  } = {}
) {
  const names = list.map(e => e.manifest.name)
  const pkgFile = path.join(ws.root, "package.json"),
    lockFile = path.join(ws.root, "package-lock.json")
  const versionOf = n => {
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
  try {
    const fresh = await open(ws.root)
    const stdout = console.log
    if (json) console.log = console.error
    try {
      compile(fresh)
    } finally {
      console.log = stdout
    }
    return { fresh }
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
    console.error(
      `✖ ${what} refused: ${e.message.split("\n")[0]}\n  package.json, package-lock.json and node_modules are as before the call`
    )
    return { code: EXIT.failed }
  }
}

/**
 * Steps 5–6: the safe part of the named packages' units (inputs filled leniently — npm has written,
 * so a mistyped --input is a named warning, never an abort), then one scoped commit: the two files
 * npm rewrites, .env.example if compile touched it, and every path an applied action reported that
 * git does not ignore. Returns `{ code, results, committed, ignored }`.
 */
export async function setupAndCommit(
  ws,
  fresh,
  names,
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
    inputFlags?: string[]
    allow?: Set<string>
    tty?: boolean
    noInput?: boolean
    io?: ReturnType<typeof ttyIO> | null
    processEnv?: NodeJS.ProcessEnv
    noCommit?: boolean
  } = {}
) {
  const skipped = new Set(skippedUnits(fresh))
  const fresh_units = units(fresh).filter(u => names.includes(u.module) && !skipped.has(u.id))
  let code = EXIT.done
  const results = []
  let ignored = []
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
  let committed = null
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

/** The unit lines a verb prints after setupAndCommit, one block per unit. */
export function printUnitResults(results, ignored, log) {
  for (const text of ignored) log(`⚠ ${text} — ignored`)
  for (const r of results) {
    const verified = r.verified ? ` · verified ${r.verified}` : ""
    log(
      `${r.state === "ready" ? "✔" : r.state === "blocked" ? "✖" : "—"} ${r.id}: ${r.state}${verified}${r.detail ? ` — ${r.detail}` : ""}`
    )
    for (const a of r.applied) log(`    ✔ ${a.id}${a.message ? ` — ${a.message}` : ""}`)
    for (const f of r.failed) log(`    ✖ ${f.id} — ${f.message}`)
    for (const p of r.problems ?? []) log(`    ✖ ${p.id} — ${p.reason}`)
    for (const p of r.pending) log(`    … ${p.id} (${p.why})${p.reason ? ` — ${p.reason}` : ""}`)
    if (r.needs.length) log(`    needs input: ${r.needs.join(", ")} — dt setup ${r.id} --input ${r.needs[0]}=<value>`)
    if (ownerStepPending(r))
      log(
        `    the owner's step (opens a browser): dt setup ${r.id}${r.needs.map(n => ` --input ${n}=<value>`).join("")} --authorize`
      )
  }
}
/** Whether a unit still has a step only the owner runs — a sign-in, a consent — pending. */
export const ownerStepPending = r =>
  (r.pending ?? []).some(p => p.runBy === "owner" || (p.effects ?? []).some(e => e.kind === "account"))

/**
 * `dt install <spec…> [--from <dir>] [--input k=v]… [--allow <kind>]… [--no-input] [--no-commit] [--json]`
 * `hooks.afterNpm` is a test seam the CLI never sets (an interruption between npm and compile).
 */
export async function installModules(
  ws,
  argv,
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
) {
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
  let allow, inputFlags
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
  let plan
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
    let fresh
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

const dotenv = ws => {
  const file = path.join(ws.root, ".env")
  return fs.existsSync(file) ? Object.fromEntries(parseEnvValues(fs.readFileSync(file, "utf8"))) : {}
}
