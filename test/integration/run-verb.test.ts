// `dt run <module> [<script> [<arg>…]]`: a module's script run by NAME. Consumers used to call module
// code by its path inside the package, so a module could not move its code into dist/ without a shim at
// every old path. These pin what the verb promises: the arguments pass through untouched (a `-w` among
// them is the script's, not the CLI's), the exit code and a killing signal come back, argv[1] is the
// script's real path so its entry-point guard holds, and an inline copy under modules/ shadows the package.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { workspace, dt, compileQuietly, compileError, readFile, ENGINE_ROOT } from "../helpers/ws.ts"

/** Prints what it was run with, as JSON — and whether its own entry-point guard holds. */
const REPORT = `import fs from "node:fs"
import { fileURLToPath } from "node:url"
const me = fileURLToPath(import.meta.url)
console.log(JSON.stringify({
  argv1: process.argv[1],
  entry: fs.realpathSync(process.argv[1]) === me,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  from: process.env.FROM ?? null,
  marker: MARKER,
}))
`
const EXIT = "process.exit(Number(process.argv[2]))\n"
const DIE = 'process.kill(process.pid, "SIGTERM")\nsetTimeout(() => {}, 10_000)\n'

/** A module package at `dir` named `name`, declaring three scripts built into dist/bin/. */
function scriptModule(dir: string, name: string, marker: string, { built = true }: { built?: boolean } = {}): void {
  fs.mkdirSync(path.join(dir, "dist", "bin"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        type: "module",
        dreamteamer: {
          description: "Checks the Northwind records.",
          scripts: { report: "dist/bin/report.js", exit: "dist/bin/exit.js", die: "dist/bin/die.js" },
        },
      },
      null,
      "\t"
    ) + "\n"
  )
  if (!built) return
  fs.writeFileSync(path.join(dir, "dist", "bin", "report.js"), REPORT.replace("MARKER", JSON.stringify(marker)))
  fs.writeFileSync(path.join(dir, "dist", "bin", "exit.js"), EXIT)
  fs.writeFileSync(path.join(dir, "dist", "bin", "die.js"), DIE)
}

/** A workspace with `@acme/tools` installed from npm (as a real folder, or a link to one outside it). */
function withTools({ link = false, built = true }: { link?: boolean; built?: boolean } = {}) {
  const fx = workspace({ compile: false })
  const at = path.join(fx.root, "node_modules", "@acme", "tools")
  if (link) {
    const real = path.join(fx.root, "vendor", "tools")
    scriptModule(real, "@acme/tools", "npm", { built })
    fs.mkdirSync(path.dirname(at), { recursive: true })
    fs.symlinkSync(real, at)
  } else scriptModule(at, "@acme/tools", "npm", { built })
  const pkgFile = path.join(fx.root, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
  pkg.dependencies = { ...pkg.dependencies, "@acme/tools": link ? "file:vendor/tools" : "1.0.0" }
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
  fx.ws.pkg = pkg
  return { ...fx, at }
}

const report = (stdout: string) => JSON.parse(stdout.trim().split("\n").pop()!)

describe("dt run", () => {
  test("a known script runs on this node at the workspace root, every argument after it passed untouched", () => {
    const { root, at } = withTools()
    const r = dt(root, "run", "@acme/tools", "report", "dana-oren", "-w", "elsewhere", "--vault=x", "--json")
    assert.equal(r.code, 0, r.stderr)
    const out = report(r.stdout)
    assert.deepEqual(out.args, ["dana-oren", "-w", "elsewhere", "--vault=x", "--json"])
    assert.equal(out.cwd, fs.realpathSync(root))
    assert.equal(out.argv1, fs.realpathSync(path.join(at, "dist", "bin", "report.js")))
    assert.equal(out.entry, true)
  })

  test("the module is addressed by its scope-stripped id as well, and from a subdirectory", () => {
    const { root } = withTools()
    fs.mkdirSync(path.join(root, "data", "deep"), { recursive: true })
    const r = spawnSync(
      process.execPath,
      [path.join(ENGINE_ROOT, "bin", "dreamteamer.js"), "run", "tools", "report", "x"],
      { cwd: path.join(root, "data", "deep"), encoding: "utf8" }
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(report(r.stdout).cwd, fs.realpathSync(root), "cwd is the workspace root, not the caller's directory")
  })

  test("a global -w BEFORE the verb still targets a workspace", () => {
    const { root } = withTools()
    const r = spawnSync(
      process.execPath,
      [path.join(ENGINE_ROOT, "bin", "dreamteamer.js"), "-w", root, "run", "tools", "report"],
      { cwd: ENGINE_ROOT, encoding: "utf8" }
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(report(r.stdout).cwd, fs.realpathSync(root))
  })

  test("argv[1] is the REAL path through a folder install's node_modules link", () => {
    const { root } = withTools({ link: true })
    const r = dt(root, "run", "tools", "report")
    assert.equal(r.code, 0, r.stderr)
    const out = report(r.stdout)
    assert.equal(out.argv1, fs.realpathSync(path.join(root, "vendor", "tools", "dist", "bin", "report.js")))
    assert.equal(out.entry, true, "the script's entry-point guard must hold")
  })

  test("the exit code passes through", () => {
    const { root } = withTools()
    assert.equal(dt(root, "run", "tools", "exit", "7").code, 7)
    assert.equal(dt(root, "run", "tools", "exit", "0").code, 0)
  })

  test("a script killed by a signal kills dt by the same signal", () => {
    const { root } = withTools()
    const r = spawnSync(process.execPath, [path.join(ENGINE_ROOT, "bin", "dreamteamer.js"), "run", "tools", "die"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    })
    assert.equal(r.status, null)
    assert.equal(r.signal, "SIGTERM")
  })

  test("no script lists the module's scripts", () => {
    const { root } = withTools()
    const r = dt(root, "run", "@acme/tools")
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /@acme\/tools \(node_modules\/@acme\/tools\)/)
    for (const n of ["die", "exit", "report"]) assert.match(r.stdout, new RegExp(`^  ${n}\\s+dist/bin/${n}\\.js$`, "m"))
  })

  test("an unknown script names the ones that exist", () => {
    const { root } = withTools()
    const r = dt(root, "run", "tools", "check-records")
    assert.equal(r.code, 1)
    assert.match(r.stderr, /@acme\/tools has no script "check-records" — its scripts: die, exit, report/)
  })

  test("an unknown module, no module at all, and a declared file never built", () => {
    const { root } = withTools()
    const none = dt(root, "run", "nope", "report")
    assert.equal(none.code, 1)
    assert.match(none.stderr, /no module "nope" in this workspace — modules with scripts: @acme\/tools/)
    const usage = dt(root, "run")
    assert.equal(usage.code, 2)
    assert.match(usage.stderr, /dt run <module> \[<script>/)
    const unbuilt = withTools({ built: false })
    const r = dt(unbuilt.root, "run", "tools", "report")
    assert.equal(r.code, 1)
    assert.match(r.stderr, /node_modules\/@acme\/tools\/dist\/bin\/report\.js, which does not exist/)
    assert.match(r.stderr, /npm run build/)
  })

  test("an inline copy of the same package under modules/ shadows the installed one", () => {
    const { root } = withTools()
    scriptModule(path.join(root, "modules", "tools"), "@acme/tools", "clone")
    const r = dt(root, "run", "@acme/tools", "report")
    assert.equal(r.code, 0, r.stderr)
    assert.equal(report(r.stdout).marker, "clone")
    assert.match(dt(root, "run", "tools").stdout, /\(modules\/tools\)/)
  })

  test("compile projects the scripts into the orientation as dt run lines, and refuses a bad shape", () => {
    const { root, ws, at } = withTools()
    assert.equal(compileQuietly(ws).code, 0)
    assert.match(readFile(root, "CLAUDE.md") ?? "", /runs: dt run tools die · dt run tools exit · dt run tools report/)
    assert.match(
      readFile(root, ".dreamteamer/modules/tools.module.yaml") ?? "",
      /scripts:\n\s+- die\n\s+- exit\n\s+- report/
    )
    const pkgFile = path.join(at, "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
    for (const [bad, msg] of [
      [["dist/x.js"], /dreamteamer\.scripts must map script names to files/],
      [{ Report: "dist/x.js" }, /a script name is lowercase letters, digits and single hyphens/],
      [{ report: "../x.js" }, /dreamteamer\.scripts\["report"\] must be a relative path inside the package/],
    ] as const) {
      pkg.dreamteamer.scripts = bad
      fs.writeFileSync(pkgFile, JSON.stringify(pkg))
      assert.match(compileError(ws) ?? "", msg)
    }
  })
})
