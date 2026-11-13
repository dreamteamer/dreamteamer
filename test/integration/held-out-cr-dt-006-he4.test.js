// held-out cr-dt-006-he4 — a preset whose setup.skipped names a unit no installed package provides.
// rnd/tests/cr-dt-006-he4.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import {
  withEngine,
  installPackage,
  folder,
  dt,
  cleanup,
  ENGINE_ROOT,
  readPkg,
  writePkg,
} from "./held-out-cr-dt-006-lib.js"

after(cleanup)

test("he4: init exits 0 with the probe skipped; status names ghost as skipped and unprovided, never crashes; setup ghost is refused and prunes nothing", () => {
  const root = withEngine(folder("he4"))
  installPackage(root, path.join(ENGINE_ROOT, "test", "fixtures", "probe-setup"))
  const pkg = readPkg(root)
  pkg.dreamteamer = { setup: { skipped: ["probe", "ghost"] } }
  writePkg(root, pkg)
  const r = dt(root, ["init", "--no-input"])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /probe\s+skipped/, `the probe unit line reads skipped:\n${r.stdout}`)
  const s = dt(root, ["status"])
  assert.equal(s.code, 0, s.stderr)
  assert.doesNotMatch(s.stdout + s.stderr, /ghost\s+blocked/, "never a blocked unit")
  const j = dt(root, ["status", "--json"])
  assert.equal(j.code, 0, j.stderr)
  const setup = JSON.parse(j.stdout).setup
  assert.ok(Array.isArray(setup))
  const text = fs.readFileSync(path.join(root, "package.json"), "utf8")
  const g = dt(root, ["setup", "ghost"])
  assert.notEqual(g.code, 0, "an unknown unit is refused")
  assert.match(g.stderr, /ghost/, "naming the unit")
  assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf8"), text, "the skip entry is not silently pruned")
  // the reviewer's reading of the design's "status says so when a declared package is gone": the orphan skip is told
  const ghostLine = s.stdout.split("\n").find(l => /^\s+ghost\s/.test(l))
  assert.ok(ghostLine, `status prints one line for ghost:\n${s.stdout}`)
  assert.match(ghostLine, /skipped/)
  assert.match(ghostLine, /no installed package provides/i)
  const ghostJson = setup.find(l => l.unit === "ghost")
  assert.ok(
    ghostJson && ghostJson.state === "skipped" && /provide/i.test(ghostJson.detail ?? ""),
    `the JSON carries ghost as skipped with a detail naming it unprovided: ${JSON.stringify(setup)}`
  )
})
