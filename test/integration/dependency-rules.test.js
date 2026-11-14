// The dependency rules (cr-dt-007, D66) through the real binary: `dt check` names a module that lists
// dreamteamer under `dependencies`; a module's `peerDependencies` floor on dreamteamer that this
// workspace misses is a compile refusal whose fix is `dt update --engine`, never `npm install dreamteamer@…`.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { workspace, writeModule } from "../helpers/ws.js"

const patch = (root, id, fn) => {
  const f = path.join(root, "modules", id, "package.json")
  const p = JSON.parse(fs.readFileSync(f, "utf8"))
  fn(p)
  fs.writeFileSync(f, JSON.stringify(p, null, "\t") + "\n")
}

describe("the engine as a dependency of a module", () => {
  test("dependencies.dreamteamer: dt check exits 1 naming the module and the fix", () => {
    const ws = workspace()
    writeModule(ws.root, "acme", { collections: { widgets: { fields: { name: { type: "string" } } } } })
    patch(ws.root, "acme", p => {
      p.dependencies = { dreamteamer: "^0.48.0" }
    })
    assert.equal(ws.dt("compile").code, 0)
    const r = ws.dt("check")
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(
      r.stdout + r.stderr,
      /acme lists dreamteamer under dependencies — a second engine would be installed beside this one/
    )
  })
  test("without it, clean", () => {
    const ws = workspace()
    writeModule(ws.root, "acme", { collections: { widgets: { fields: { name: { type: "string" } } } } })
    patch(ws.root, "acme", p => {
      p.devDependencies = { dreamteamer: "0.48.0" }
    })
    assert.equal(ws.dt("compile").code, 0)
    assert.equal(ws.dt("check").code, 0)
  })
  test("a peerDependencies floor on dreamteamer this workspace misses: the fix is dt update --engine", () => {
    const ws = workspace()
    writeModule(ws.root, "acme", { collections: { widgets: { fields: { name: { type: "string" } } } } })
    patch(ws.root, "acme", p => {
      p.peerDependencies = { dreamteamer: ">=99.0.0" }
    })
    const r = ws.dt("compile")
    assert.notEqual(r.code, 0)
    assert.match(r.stderr + r.stdout, /needs "dreamteamer" >=99\.0\.0/)
    assert.match(r.stderr + r.stdout, /fix: dt update --engine/)
    assert.doesNotMatch(r.stderr + r.stdout, /npm install "dreamteamer@/)
  })
})
