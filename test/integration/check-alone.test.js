// `dt check modules/<id> --alone` (cr-dt-007, G3, D63, D65): the module packed, installed into a fresh
// workspace on this engine with only its declared dependencies, compiled, checked — exit 0
// publishable, 1 refused naming why, 2 usage. Offline: dependencies are packed from this workspace.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { workspace, ENGINE_ROOT, git } from "../helpers/ws.js"

const BIN = path.join(ENGINE_ROOT, "bin", "dreamteamer.js")
const FIX = path.join(ENGINE_ROOT, "test", "fixtures", "alone")
const run = (root, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 400_000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      NO_COLOR: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  })
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}
/** A workspace holding the named fixtures as inline modules (copied, never compiled here: the gate needs no host compile). */
function host(...ids) {
  const ws = workspace()
  for (const id of ids) fs.cpSync(path.join(FIX, id), path.join(ws.root, "modules", id), { recursive: true })
  git(ws.root, ["add", "-A"])
  git(ws.root, ["commit", "-qm", "fixtures"])
  return ws
}

describe("dt check modules/<id> --alone", () => {
  test("publishable, with an inline dependency packed alongside: exit 0, the verdict printed", () => {
    const ws = host("alone-base", "alone-ok")
    const r = run(ws.root, ["check", "modules/alone-ok", "--alone"])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /✔ modules\/alone-ok is publishable — packed, installed alone \(with alone-base\), compiled, checked/
    )
  })
  test("a unit that needs an input a stranger supplies later is still publishable: exit 0", () => {
    const ws = host("alone-needs-input")
    const r = run(ws.root, ["check", "modules/alone-needs-input", "--alone"])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /alone\s+configured/)
    assert.match(r.stdout, /dt setup alone --input token=<token>/)
  })
  test("a dependency nothing here holds: exit 1, named", () => {
    const ws = host("alone-missing-dep")
    const r = run(ws.root, ["check", "modules/alone-missing-dep", "--alone"])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /✖ modules\/alone-missing-dep: dependency @alone\/nowhere is not installed here/)
  })
  test("a floor above this engine: exit 1, the floor named", () => {
    const ws = host("alone-floor-above")
    const r = run(ws.root, ["check", "modules/alone-floor-above", "--alone"])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /✖ modules\/alone-floor-above: .*>=99\.0\.0/)
  })
  test("usage: a target without --alone, --alone without a target, a target that is not an inline module", () => {
    const ws = host("alone-base")
    const a = run(ws.root, ["check", "modules/alone-base"])
    assert.equal(a.code, 2)
    assert.match(a.stderr, /check takes no target — did you mean --alone\?/)
    const b = run(ws.root, ["check", "--alone"])
    assert.equal(b.code, 2)
    assert.match(b.stderr, /check --alone takes modules\/<id>/)
    const c = run(ws.root, ["check", "modules/nope", "--alone"])
    assert.equal(c.code, 2)
    assert.match(c.stderr, /modules\/nope is not an inline module of this workspace/)
  })
  test("--keep leaves the temp workspace and prints where it is", () => {
    const ws = host("alone-base")
    const r = run(ws.root, ["check", "modules/alone-base", "--alone", "--keep"])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const kept = /kept: (\S+)/.exec(r.stdout)?.[1]
    assert.ok(kept && fs.existsSync(path.join(kept, "package.json")), r.stdout)
    fs.rmSync(path.dirname(kept), { recursive: true, force: true })
  })
})
