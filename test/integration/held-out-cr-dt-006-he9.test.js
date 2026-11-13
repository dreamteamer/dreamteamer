// held-out cr-dt-006-he9 — init --from a folder that lacks one of the preset's declared packages is
// refused before any write, with no registry call; the complete folder installs with package.json
// byte-identical, one scoped commit, and a second run changes nothing. rnd/tests/cr-dt-006-he9.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { withEngine, packInto, folder, dt, git, treeHash, cleanup } from "./held-out-cr-dt-006-lib.js"

after(cleanup)
const A = { name: "@fix/a", version: "1.0.0", description: "a", dreamteamer: { description: "a" } }
const B = { name: "@fix/b", version: "1.0.0", description: "b", dreamteamer: { description: "b" } }
const preset = name => withEngine(folder(name), { extra: { dependencies: { "@fix/a": "1.0.0", "@fix/b": "1.0.0" } } })

test("he9: a folder lacking @fix/a — exit 1 naming the package and the folder, before npm, nothing written, no registry", () => {
  const from = packInto(folder("reg-partial"), [B])
  const root = preset("he9-partial")
  const text = fs.readFileSync(path.join(root, "package.json"), "utf8")
  const listing = fs.readdirSync(root).sort()
  const before = treeHash(root)
  const r = dt(root, ["init", "--from", from])
  assert.equal(r.code, 1, r.stdout + r.stderr)
  const out = r.stdout + r.stderr
  assert.match(out, /@fix\/a/, "names the package")
  assert.match(out, new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "names the folder")
  assert.doesNotMatch(out, /ENOTFOUND|E404|ECONNREFUSED|EAI_AGAIN/, "the refusal is the engine's, not npm's")
  assert.doesNotMatch(r.stdout, /▶ dependencies: npm/, "npm did not run")
  assert.ok(!fs.existsSync(path.join(root, "package-lock.json")), "no lockfile")
  assert.ok(!fs.existsSync(path.join(root, "node_modules", "@fix")), "nothing installed")
  assert.ok(!fs.existsSync(path.join(root, ".dreamteamer")), "no runtime")
  // the record's reading of "one thing named, nothing half-written": refused before any write
  assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf8"), text, "package.json untouched")
  assert.deepEqual(fs.readdirSync(root).sort(), listing, "no file was added to the folder")
  assert.equal(treeHash(root), before, "tree hash unchanged")
})

test("he9: the complete folder — a and b from the folder, the preset's specs unchanged, one scoped commit, the board; a second run changes zero files", () => {
  const from = packInto(folder("reg-full"), [A, B])
  const root = preset("he9-full")
  const text = fs.readFileSync(path.join(root, "package.json"), "utf8")
  const r = dt(root, ["init", "--from", from])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  for (const n of ["a", "b"])
    assert.ok(fs.existsSync(path.join(root, "node_modules", "@fix", n, "package.json")), `${n} installed`)
  const { dreamteamer: block, ...rest } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  assert.deepEqual(rest, JSON.parse(text), "the preset's own specs are unchanged (no file: rewrite)")
  assert.ok(block, "init added its block")
  assert.equal(git(root, ["rev-list", "--count", "HEAD"]), "1", "one commit")
  assert.match(git(root, ["log", "-1", "--format=%s"]), /^dreamteamer: init workspace/)
  assert.equal(git(root, ["status", "--porcelain"]), "")
  assert.match(r.stdout, /modules:|setup:|ready: dreamteamer@/, "the board printed")
  const before = treeHash(root)
  const again = dt(root, ["init", "--from", from])
  assert.equal(again.code, 0, again.stderr)
  assert.equal(treeHash(root), before, "the second run changed zero files")
  assert.equal(git(root, ["rev-list", "--count", "HEAD"]), "1")
})
