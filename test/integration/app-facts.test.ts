// Tier 2 — the repo facts the desktop app reads in-process instead of asking git or parsing the
// runtime itself (0.52.0). Each is the code a `dt` verb already runs, exported, so a person in the app
// and an agent running `dt` get one answer: `aheadCount` is the count `dt commit` reports after a write,
// `moduleRows` the enumeration `--module` validation and the "known:" list read.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import * as dt from "../../src/api.ts"
import { twoModuleWorkspace, workspace, git } from "../helpers/ws.ts"

const commit = (root: string, file: string) => {
  fs.writeFileSync(path.join(root, file), `${file}\n`)
  git(root, ["add", "--", file])
  git(root, ["commit", "-qm", file])
}

describe("aheadCount", () => {
  test("counts the commits the upstream does not have", () => {
    const ws = workspace()
    const remote = `${ws.root}-remote.git`
    git(path.dirname(remote), ["init", "-q", "--bare", remote])
    git(ws.root, ["remote", "add", "origin", remote])
    git(ws.root, ["push", "-q", "-u", "origin", "HEAD"])
    assert.equal(dt.aheadCount(ws.root), 0, "level with its upstream")
    commit(ws.root, "a.txt")
    commit(ws.root, "b.txt")
    assert.equal(dt.aheadCount(ws.root), 2)
    fs.rmSync(remote, { recursive: true, force: true })
  })

  test("a repo with no upstream counts what is on no remote", () => {
    const ws = workspace()
    // the fixture's history is on no remote at all, so every commit is unpushed
    const commits = Number(git(ws.root, ["rev-list", "--count", "HEAD"]))
    assert.equal(dt.aheadCount(ws.root), commits)
  })
})

describe("moduleRows", () => {
  test("lists every compiled module with the fields its package.json declares", () => {
    const ws = twoModuleWorkspace()
    const rows = dt.moduleRows(ws.store!)
    const hr = rows.find(r => r.id === "hr")
    const core = rows.find(r => r.id === "core")
    assert.ok(hr && core, `known: ${rows.map(r => r.id).join(", ")}`)
    assert.deepEqual(hr.fields.namespaces, ["hr"])
    assert.equal(core.fields.description, "The shared nouns.")
  })
})
