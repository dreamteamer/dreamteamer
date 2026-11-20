// Tier 2 — A SCHEMA COMMIT RUNS IN THE REPO THAT HOLDS THE SOURCE (§9).
//
// `writeGated` ran `git add`/`git commit` at the WORKSPACE root — so a schema write into a module that
// is its own repo (and that the workspace gitignores) compiled, failed to commit, and rolled back.
// The failure named git ("git commit failed — the schema change was rolled back") for a source the
// operator could see on disk and had every right to edit.
//
// `repoRootOf` has been in compile.js since owns-data needed it; this routes the commit through it.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { twoModuleWorkspace, git, readFile } from "../helpers/ws.ts"
import { load } from "../../src/lib/yaml.ts"

/**
 * Turn `modules/hr` into a module that is ITS OWN REPO, with its own history, which the workspace
 * gitignores — a module someone cloned into `modules/`.
 *
 * ⚠ Not a real `git clone` from a remote — a repo with no origin is enough, because the thing under test
 * is which repo the commit lands in, and the report counts "ahead" against what is on no remote.
 */
function asGitModule(ws, id) {
  const to = path.join(ws.root, "modules", id)
  git(ws.root, ["rm", "-rq", "--cached", "--", `modules/${id}`])
  fs.appendFileSync(path.join(ws.root, ".gitignore"), `\n/modules/${id}/\n`)
  git(ws.root, ["add", ".gitignore"])
  git(ws.root, ["commit", "-qm", `workspace: ${id} is its own repo`])
  git(to, ["init", "-q"])
  git(to, ["config", "user.email", "test@example.invalid"])
  git(to, ["config", "user.name", "dreamteamer test"])
  git(to, ["add", "-A"])
  git(to, ["commit", "-qm", `${id}: initial`])
  return to
}

describe("a schema write into a module that is its own repo", () => {
  test("COMMITS IN THE MODULE'S REPO — it used to compile, fail to commit, and roll back", () => {
    const ws = twoModuleWorkspace()
    const clone = asGitModule(ws, "hr")
    assert.equal(ws.dt("compile").code, 0)
    const wsBefore = ws.git(["rev-parse", "HEAD"])
    const cloneBefore = git(clone, ["rev-parse", "HEAD"])

    const res = ws.dt("add-field", "hr/positions", "--name", "grade", "--type", "integer")
    assert.equal(res.code, 0, res.stdout + res.stderr)

    // the field is on disk, in the clone
    assert.equal(
      load<any>(readFile(ws.root, "modules/hr/collections/hr/positions.collection.yaml")).fields.grade.type,
      "integer"
    )
    // and COMMITTED there, not in the workspace
    assert.notEqual(git(clone, ["rev-parse", "HEAD"]), cloneBefore, "the clone received the commit")
    assert.equal(ws.git(["rev-parse", "HEAD"]), wsBefore, "the workspace has nothing to commit")
    assert.equal(git(clone, ["status", "--porcelain"]), "", "nothing left dirty in the clone")
    assert.match(git(clone, ["log", "-1", "--pretty=%s"]), /add-field grade/)
  })

  test("the report names the repo and says the clone is ahead", () => {
    const ws = twoModuleWorkspace()
    asGitModule(ws, "hr")
    assert.equal(ws.dt("compile").code, 0)
    const res = ws.dt("add-field", "hr/positions", "--name", "grade", "--type", "integer")
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, /✔ committed in modules\/hr \(\w+, ahead \d+ — push when ready\)/)
  })

  test("a workspace-module write still reports the workspace, with no ahead count", () => {
    const ws = twoModuleWorkspace()
    const res = ws.dt("add", "collections", "--name", "grades")
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, /✔ committed in the workspace \(\w+\)/)
    assert.doesNotMatch(res.stdout, /push when ready/)
  })

  test("a write spanning TWO repos is one commit PER repo, and each is complete", () => {
    const ws = twoModuleWorkspace()
    const clone = asGitModule(ws, "hr")
    // core stays inline (workspace repo); the overlay lives in the clone
    const pkgFile = path.join(clone, "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
    pkg.dreamteamer = { ...pkg.dreamteamer, dependencies: ["core"] }
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
    git(clone, ["add", "-A"])
    git(clone, ["commit", "-qm", "hr: depend on core"])
    assert.equal(ws.dt("compile").code, 0)

    const wsBefore = ws.git(["rev-parse", "HEAD"])
    const cloneBefore = git(clone, ["rev-parse", "HEAD"])
    // an overlay in hr on core's `people` — the write is in the clone, and `people`'s own
    // descriptor in the workspace repo is untouched by this verb
    const res = ws.dt("add-field", "people", "--name", "badge", "--type", "string", "--module", "hr")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.notEqual(git(clone, ["rev-parse", "HEAD"]), cloneBefore)
    assert.equal(ws.git(["rev-parse", "HEAD"]), wsBefore)
    assert.equal(git(clone, ["status", "--porcelain"]), "")
    // ⚠ SCOPED to what a schema write can touch. `dt init` now seeds every known harness, so a
    // fixture carries untracked AGENTS.md/GEMINI.md/CLAUDE.md — noise for this assertion, and
    // nothing to do with whether the verb left a straggler.
    assert.equal(ws.git(["status", "--porcelain", "--", "modules", "package.json"]), "", "no stragglers in either repo")
  })

  test("a module that authors its namespaced descriptor FLAT is still the owner", () => {
    // ⚠ THE DEFECT THIS PINS, found by driving a workspace with a cloned module: a module
    // owning its namespace (§8) has no reason to repeat it in every path, so `hr` authors
    // `collections/positions.collection.yaml` with `name: hr/positions`. `baseDescriptorSource`
    // matched a source by requiring `collections/<name>.collection.yaml` in the PATH, so that
    // base was invisible — and `add-field hr/positions` created an overlay in the WORKSPACE
    // module and then failed compile for a dependency nobody asked for. That is the exact defect
    // this wave exists to remove, one layer down from where Task 1 removed it.
    const ws = twoModuleWorkspace()
    const clone = asGitModule(ws, "hr")
    // flatten the descriptor inside the clone: same `name`, a path that no longer mirrors it
    fs.renameSync(
      path.join(clone, "collections/hr/positions.collection.yaml"),
      path.join(clone, "collections/positions.collection.yaml")
    )
    fs.rmSync(path.join(clone, "collections/hr"), { recursive: true, force: true })
    git(clone, ["add", "-A"])
    git(clone, ["commit", "-qm", "hr: author the descriptor flat"])
    assert.equal(ws.dt("compile").code, 0)

    const res = ws.dt("add-field", "hr/positions", "--name", "grade", "--type", "integer")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.match(
      res.stdout,
      /modules\/hr\/collections\/positions\.collection\.yaml/,
      "the OWNER's own descriptor, at the path it actually has"
    )
    assert.equal(
      readFile(ws.root, "modules/default/collections/hr/positions.collection.yaml"),
      null,
      "no overlay was invented in the workspace module"
    )
    assert.equal(
      load<any>(readFile(ws.root, "modules/hr/collections/positions.collection.yaml")).fields.grade.type,
      "integer"
    )
  })

  test("a FAILED commit in one repo rolls the whole op back, in both", () => {
    const ws = twoModuleWorkspace()
    const clone = asGitModule(ws, "hr")
    assert.equal(ws.dt("compile").code, 0)
    const before = load<any>(readFile(ws.root, "modules/hr/collections/hr/positions.collection.yaml"))
    // ⚠ UNSETTING THE CLONE'S IDENTITY IS NOT ENOUGH — `dt()` passes GIT_AUTHOR_*/GIT_COMMITTER_*
    // through the environment (test/helpers/ws.js), so git has an identity whatever the repo
    // config says. Make `.git` unwritable instead: no env var rescues that.
    fs.chmodSync(path.join(clone, ".git"), 0o500)
    const res = ws.dt("add-field", "hr/positions", "--name", "grade", "--type", "integer")
    fs.chmodSync(path.join(clone, ".git"), 0o700)
    assert.equal(res.code, 1)
    assert.match(res.stderr, /rolled back/)
    assert.deepEqual(
      load<any>(readFile(ws.root, "modules/hr/collections/hr/positions.collection.yaml")),
      before,
      "the source is byte-for-byte what it was"
    )
    assert.equal(ws.dt("check").code, 0)
  })
})

// The gate compile regenerates the root harness files (CLAUDE.md, AGENTS.md, GEMINI.md). They are
// build output and gitignored (test/integration/harness-order.test.js), so a schema write's commit
// pathspec must never name them: `git add` on an ignored path is a hard error, and it would fail the
// write it was only regenerating for.
describe("a schema write never hands a gitignored harness file to git add", () => {
  test("the write commits, and the ignored root files stay out of it", () => {
    const ws = twoModuleWorkspace()
    assert.ok(fs.existsSync(path.join(ws.root, ".claude/skills")), "the fixture writes the ignored dir")
    assert.equal(ws.git(["check-ignore", ".claude/skills"]).trim(), ".claude/skills")
    assert.equal(ws.git(["check-ignore", "CLAUDE.md"]).trim(), "CLAUDE.md", "the root harness file is ignored")
    const res = ws.dt("set", "collections/people", "description=Still a person.")
    assert.equal(res.code, 0, `an ignored path in the pathspec would have failed this: ${res.stderr}`)
    assert.match(readFile(ws.root, "CLAUDE.md"), /Still a person\./, "the gate compile regenerated it")
    assert.doesNotMatch(ws.git(["show", "--stat", "--oneline", "HEAD"]), /CLAUDE\.md|AGENTS\.md|GEMINI\.md/)
    assert.equal(ws.git(["status", "--porcelain", "--", "modules"]), "", "the source change is committed")
  })
})
