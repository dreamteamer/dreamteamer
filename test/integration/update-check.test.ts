// Tier 2 — `dt update --check` and `--all` (0.53.0): what an upgrade would move, and moving it, offline. Two versions of
// one small module are packed into folders of tarballs: 1.0.0 is installed from the first, and the second holds 1.0.0
// and 1.1.0, so `--from` there answers "1.1.0 is the latest". The engine is the fixture's development link, so it is
// listed and never offered.
import { test, describe, before } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import * as dt from "../../src/api.ts"
import { workspace, git, ENGINE_ROOT } from "../helpers/ws.ts"
import { openWorkspace } from "../../src/openWorkspace.ts"

const NAME = "@up/a"

/** Pack `@up/a@<version>` into `dest`. */
function pack(version: string, dest: string) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "dt-up-src-"))
  fs.writeFileSync(
    path.join(src, "package.json"),
    JSON.stringify({ name: NAME, version, description: "An upgrade fixture.", dreamteamer: {}, files: [] }, null, 2)
  )
  fs.writeFileSync(path.join(src, "README.md"), `# ${NAME} ${version}\n`)
  const r = spawnSync("npm", ["pack", src, "--pack-destination", dest, "--silent"], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
}

let oldOnly: string
let both: string

before(() => {
  oldOnly = fs.mkdtempSync(path.join(os.tmpdir(), "dt-up-old-"))
  both = fs.mkdtempSync(path.join(os.tmpdir(), "dt-up-both-"))
  pack("1.0.0", oldOnly)
  pack("1.0.0", both)
  pack("1.1.0", both)
})

/** A workspace with @up/a 1.0.0 installed and committed. */
function installed() {
  const ws = workspace()
  const r = ws.dt!("install", NAME, "--from", oldOnly, "--no-input")
  assert.equal(r.code, 0, r.stdout + r.stderr)
  return ws
}

const versionOf = (root: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "node_modules", "@up", "a", "package.json"), "utf8")).version

describe("dt update --check", () => {
  test("lists the module as 1.0.0 → 1.1.0, and the linked engine as never offered", () => {
    const ws = installed()
    const r = ws.dt!("update", "--check", "--from", both, "--json")
    assert.equal(r.code, 0, r.stderr)
    const { packages, outdated } = JSON.parse(r.stdout)
    const mod = packages.find(p => p.name === NAME)
    assert.deepEqual(
      { installed: mod.installed, latest: mod.latest, outdated: mod.outdated, kind: mod.kind },
      { installed: "1.0.0", latest: "1.1.0", outdated: true, kind: "module" }
    )
    const engine = packages.find(p => p.name === "dreamteamer")
    assert.equal(engine.kind, "engine")
    assert.equal(engine.linked, true, "the fixture's engine is a development link")
    assert.equal(engine.outdated, false)
    assert.equal(outdated, 1)
  })

  test("the text form names the move and the verb that makes it", () => {
    const ws = installed()
    const r = ws.dt!("update", "--check", "--from", both)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /@up\/a\s+1\.0\.0 → 1\.1\.0/)
    assert.match(r.stdout, /1 of \d+ can move forward — dt update --all/)
  })

  test("the export answers what the verb prints", async () => {
    const ws = installed()
    const rows = await dt.updateCheck(await openWorkspace(ws.root), { from: both })
    assert.equal(rows.find(r => r.name === NAME)?.latest, "1.1.0")
    assert.equal(rows[0].kind, "engine", "the engine is listed first")
  })
})

describe("dt update --all", () => {
  test("moves every outdated module, commits it, and leaves nothing to check", () => {
    const ws = installed()
    const r = ws.dt!("update", "--all", "--from", both)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(versionOf(ws.root), "1.1.0")
    assert.match(git(ws.root, ["log", "-1", "--format=%s"]), /update @up\/a 1\.0\.0 → 1\.1\.0/)
    const after = JSON.parse(ws.dt!("update", "--check", "--from", both, "--json").stdout)
    assert.equal(after.outdated, 0)
  })

  test("with nothing outdated it says so and changes nothing", () => {
    const ws = installed()
    const head = git(ws.root, ["rev-parse", "HEAD"])
    const r = ws.dt!("update", "--all", "--from", oldOnly)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /every package is at its latest release/)
    assert.equal(git(ws.root, ["rev-parse", "HEAD"]), head)
  })
})

describe("drift: a pulled upgrade, pins moved and node_modules not", () => {
  /** A checkout whose lockfile and package.json pin @up/a 1.1.0 while node_modules holds 1.0.0 — what a teammate's
   *  pushed `dt update` looks like after a pull. The engine is a file: dependency so `npm ci` needs no registry. */
  function pulled() {
    const ws = installed()
    const pkgFile = path.join(ws.root, "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
    pkg.dependencies = { ...pkg.dependencies, dreamteamer: `file:${ENGINE_ROOT}` }
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
    const tgz = path.join(
      both,
      fs.readdirSync(both).find(f => f.endsWith("1.1.0.tgz"))!
    )
    const r = spawnSync("npm", ["install", "--save-exact", "--package-lock-only", "--no-audit", "--no-fund", tgz], {
      cwd: ws.root,
      encoding: "utf8",
    })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(versionOf(ws.root), "1.0.0", "node_modules is still the old version")
    return ws
  }

  test("dt status --json reports the package installed at another version than pinned", () => {
    const ws = pulled()
    const r = ws.dt!("status", "--json")
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout).drift, [{ name: NAME, pinned: "1.1.0", installed: "1.0.0" }])
    assert.match(ws.dt!("status").stdout, /drift:\n {2}@up\/a\s+1\.0\.0 installed, 1\.1\.0 pinned — dt install/)
  })

  test("dt install brings node_modules to the pins, and the drift is gone", () => {
    const ws = pulled()
    const r = ws.dt!("install")
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(versionOf(ws.root), "1.1.0")
    assert.deepEqual(
      dt.installDrift({ root: ws.root, pkg: JSON.parse(fs.readFileSync(path.join(ws.root, "package.json"), "utf8")) }),
      []
    )
  })
})
