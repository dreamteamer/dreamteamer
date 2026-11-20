import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { discoverModules } from "../workspace/discoverModules.ts"
import type { PackageJson, Workspace } from "../types.ts"

const USAGE_LINE = "dt run <module> [<script> [<arg>…]] — the module by package name (@scope/name) or id"

/**
 * `dt run <module> [<script> [<arg>…]]` — run a script a module declares in `dreamteamer.scripts`, by
 * NAME. Workspaces, command files and `npm run check` lines used to run module code by its path inside
 * the package (`node node_modules/@x/y/bin/check.mjs`), so a module could never move its code — into
 * `dist/`, where a TypeScript module's code has to live — without shipping a shim at every old path.
 *
 * The module resolves through `discoverModules`, the layering extensions load through: `modules/<id>`,
 * then the installed package, so an inline copy shadows what npm installed and a disabled module is not there at all. The script runs on this node (`process.execPath`), at the
 * workspace root, with the terminal; its exit code is returned and a signal that killed it kills this
 * process too. `argv[1]` is the script's REAL path, so a script's "am I the entry point" guard — its
 * own realpath against argv[1]'s — holds through the node_modules symlink a `./folder` install makes.
 *
 * Without a script it lists the module's. Exit 2 is usage, 1 a module or script that is not there.
 */
export async function runModuleScript(ws: Workspace, argv: string[]): Promise<number> {
  const [target, script, ...rest] = argv
  if (!target) {
    console.error(`✖ ${USAGE_LINE}`)
    return 2
  }
  const { modules } = discoverModules(ws.root, ws.pkg)
  const wanted = target.replace(/^modules\//, "")
  const exact = modules.find(m => m.name === wanted)
  const byId = modules.filter(m => m.name.replace(/^@[^/]+\//, "") === wanted)
  if (!exact && byId.length > 1) {
    console.error(`✖ "${wanted}" is the id of ${byId.map(m => m.name).join(" and ")} — name the package`)
    return 2
  }
  const mod = exact ?? byId[0]
  const scriptsOf = (root: string): Record<string, string> => {
    try {
      const pkg: PackageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
      const s = pkg.dreamteamer?.scripts
      return s && typeof s === "object" && !Array.isArray(s) ? s : {}
    } catch {
      return {}
    }
  }
  if (!mod) {
    const withScripts = modules.filter(m => Object.keys(scriptsOf(m.root)).length).map(m => m.name)
    console.error(
      `✖ no module "${wanted}" in this workspace — ${withScripts.length ? `modules with scripts: ${withScripts.join(", ")}` : "no module here declares scripts"}`
    )
    return 1
  }
  const scripts = scriptsOf(mod.root)
  const names = Object.keys(scripts).sort()
  const where = path.relative(ws.root, mod.root) || "."
  if (!script) {
    if (!names.length) {
      console.log(`${mod.name} (${where}) declares no scripts — a module names them in dreamteamer.scripts`)
      return 0
    }
    const width = Math.max(...names.map(n => n.length))
    console.log(`${mod.name} (${where}) — dt run ${wanted} <script> [<arg>…]`)
    for (const n of names) console.log(`  ${n.padEnd(width)}  ${scripts[n]}`)
    return 0
  }
  if (!Object.hasOwn(scripts, script)) {
    console.error(
      `✖ ${mod.name} has no script "${script}" — ${names.length ? `its scripts: ${names.join(", ")}` : "it declares none (dreamteamer.scripts)"}`
    )
    return 1
  }
  const file = path.join(mod.root, String(scripts[script]))
  if (!fs.existsSync(file)) {
    console.error(
      `✖ ${mod.name}'s script "${script}" is ${path.relative(ws.root, file)}, which does not exist — when it is build output, run the module's build (\`npm run build\` in ${where})`
    )
    return 1
  }
  return passThrough(fs.realpathSync(file), rest, ws.root)
}

/**
 * Run `node <file> <args>` with the terminal, resolving to its exit code. A terminal's Ctrl-C reaches
 * the child itself (one process group), so this process only waits for it; a signal sent to THIS
 * process is forwarded. A child killed by a signal re-raises it here, so a caller sees the same death.
 */
function passThrough(file: string, args: string[], cwd: string): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [file, ...args], { cwd, stdio: "inherit" })
    const forward = (sig: NodeJS.Signals): void => void child.kill(sig)
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
    for (const s of signals) process.on(s, forward)
    child.on("error", e => {
      console.error(`✖ ${e.message}`)
      resolve(1)
    })
    child.on("exit", (code, signal) => {
      for (const s of signals) process.off(s, forward)
      if (signal) process.kill(process.pid, signal)
      resolve(code ?? 1)
    })
  })
}
