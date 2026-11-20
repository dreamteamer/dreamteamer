// Cross-repo references without stub records (cr-dt-004): `dreamteamer-exports.json`, `dt exports`,
// external references in `dt check`, and `dt get` / `Store.external`. The design's T-numbers are named
// on each test. Every fixture is synthetic: a workspace W (package `w-pkg`) whose collections come from an
// inline module `org`, and whose manifest vouches for ids it does not hold.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { workspace, compileQuietly, readFile, git, dt } from "../helpers/ws.ts"
import { Store } from "../../src/store/Store.ts"
import { serializeExports } from "../../src/exports/serializeExports.ts"

const PEOPLE =
  'name: people\nstorage:\n  suffix: person\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n'
const PROJECTS =
  'name: projects\nstorage:\n  suffix: project\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n'
const TASKS =
  'name: tasks\nstorage:\n  suffix: task\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  project:\n    type: projects\n  assignee:\n    type: people\n  pic:\n    type: pics\n'
const PICS = "name: pics\nstorage:\n  suffix: pic\n  format: binary\nfields: {}\n"
const MANIFEST = "dreamteamer-exports.json"

function commitAll(dir, msg) {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    git(dir, ["init", "-q"])
    git(dir, ["config", "user.email", "test@example.invalid"])
    git(dir, ["config", "user.name", "dreamteamer test"])
  }
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", msg, "--allow-empty"])
}
const write = (dir, files) => {
  for (const [rel, body] of Object.entries<any>(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
}
const person = name => `---\nname: ${name}\n---\n`
const task = (name, fields = {}) =>
  `---\nname: ${name}\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n`

/** A workspace named `pkg` holding `files`, its collections from the inline module `org`. */
function ws({ pkg = "w-pkg", files = {} }: Record<string, any> = {}) {
  const w = workspace({ compile: false })
  write(path.join(w.root, "modules", "org"), {
    "package.json": JSON.stringify({ name: "org", version: "1.0.0", dreamteamer: {} }),
    "collections/people.collection.yaml": PEOPLE,
    "collections/projects.collection.yaml": PROJECTS,
    "collections/tasks.collection.yaml": TASKS,
    "collections/pics.collection.yaml": PICS,
  })
  const pkgPath = path.join(w.root, "package.json")
  const manifest = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  manifest.name = pkg
  fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, "\t") + "\n")
  write(w.root, files)
  commitAll(w.root, "ws")
  w.ws.pkg = manifest
  compileQuietly(w.ws)
  return w
}
const head = dir => git(dir, ["rev-parse", "HEAD"]).trim()
const manifestOf = dir => JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")).references
// a manifest as `dt exports` (or the migration) would have written it
const handManifest = (dir, refs) => fs.writeFileSync(path.join(dir, MANIFEST), serializeExports(refs))
const commitManifest = dir => {
  git(dir, ["add", MANIFEST])
  git(dir, ["commit", "-qm", "manifest"])
}

/** W's task names people/eli, held elsewhere and vouched for by W's committed manifest. */
const vouched = (extra: Record<string, any> = {}) => {
  const w = ws({ files: { "data/tasks/t1.task.md": task("t1", { assignee: "people/eli" }), ...(extra.files ?? {}) } })
  handManifest(w.root, { people: { eli: { label: "Eli", from: "far" }, ...(extra.people ?? {}) } })
  commitManifest(w.root)
  return w
}

describe("external references (cr-dt-004)", () => {
  // T2 (rnd/tests/dreamteamer/cr-dt-004-t2)
  test("a reference no root answers is external when the manifest lists it; dangling without", () => {
    const w = ws({ files: { "data/tasks/t1.task.md": task("t1", { assignee: "people/dana" }) } })
    const bare = dt(w.root, "check")
    assert.equal(bare.code, 1, bare.stdout)
    assert.match(bare.stdout, /dangling reference "people\/dana"/)
    handManifest(w.root, { people: { dana: { label: "Dana", from: "hq-pkg" } } })
    const res = dt(w.root, "check")
    assert.equal(res.code, 0, res.stdout)
    assert.match(
      res.stdout,
      /^ℹ 1 reference to 1 record outside this workspace, vouched for by its exports manifest \(people\/dana\)$/m
    )
    assert.doesNotMatch(res.stdout, /dangling/)
  })

  // T10 (rnd/tests/dreamteamer/cr-dt-004-t2)
  test("a binary target is an ordinary entry", () => {
    const w = ws({ files: { "data/tasks/t1.task.md": task("t1", { pic: "pics/p1" }) } })
    handManifest(w.root, { pics: { p1: { label: "p1", from: "far" } } })
    const res = dt(w.root, "check")
    assert.equal(res.code, 0, res.stdout)
    assert.match(res.stdout, /vouched for by its exports manifest \(pics\/p1\)/)
  })
})

// rnd/tests/dreamteamer/write-accepts-exports-vouched-reference — a write judges a reference the way
// `check` does: an id no root holds that the manifest vouches for is accepted; a vouched id whose holder
// is this workspace, which lacks it, is refused, naming the holder.
describe("a write accepts what check accepts: references the exports manifest vouches for", () => {
  test("dt set and dt add accept a vouched id; check agrees; without the entry both refuse", () => {
    const w = ws({ files: { "data/tasks/t1.task.md": task("t1") } })
    const bare = dt(w.root, "set", "tasks/t1", "assignee=people/dana")
    assert.equal(bare.code, 1, bare.stdout)
    assert.match(bare.stderr, /dangling reference "people\/dana"/)
    handManifest(w.root, { people: { dana: { label: "Dana", from: "hq-pkg" } } })
    const set = dt(w.root, "set", "tasks/t1", "assignee=people/dana")
    assert.equal(set.code, 0, set.stderr)
    assert.match(readFile(w.root, "data/tasks/t1.task.md"), /assignee: people\/dana/)
    const add = dt(w.root, "add", "tasks", "--name", "t2", "--assignee", "people/dana")
    assert.equal(add.code, 0, add.stderr)
    const check = dt(w.root, "check")
    assert.equal(check.code, 0, check.stdout)
    assert.match(check.stdout, /2 references to 1 record outside this workspace, vouched for by its exports manifest/)
  })

  test("a vouched id whose holder is this workspace and lacks it is refused, naming the holder; nothing is written", () => {
    const w = ws({ files: { "data/tasks/t1.task.md": task("t1") } })
    handManifest(w.root, { people: { zed: { label: "Zed", from: "w-pkg" } } })
    const before = readFile(w.root, "data/tasks/t1.task.md")
    const res = dt(w.root, "set", "tasks/t1", "assignee=people/zed")
    assert.equal(res.code, 1, res.stdout)
    assert.match(
      res.stderr,
      /dangling reference "people\/zed" — no such record \(its holder w-pkg is read here and does not have it\)/
    )
    assert.equal(readFile(w.root, "data/tasks/t1.task.md"), before)
  })
})

describe("dt exports (cr-dt-004)", () => {
  // T5b (rnd/tests/dreamteamer/cr-dt-004-t4)
  test("an emptied manifest is deleted in a commit; an unparseable one is a violation and is never overwritten; a pull is judged at once", () => {
    const w = vouched()
    fs.rmSync(path.join(w.root, "data/tasks/t1.task.md"))
    git(w.root, ["commit", "-qam", "drop t1"])
    assert.equal(dt(w.root, "exports").code, 0)
    assert.equal(fs.existsSync(path.join(w.root, MANIFEST)), false)
    assert.match(git(w.root, ["show", "--name-status", "--format=", "HEAD"]), /^D\tdreamteamer-exports\.json$/m)
    fs.writeFileSync(path.join(w.root, MANIFEST), "{ <<<<<<< ours")
    const check = dt(w.root, "check")
    assert.equal(check.code, 1)
    assert.match(check.stdout, /✖ dreamteamer-exports\.json\n\s+dreamteamer-exports\.json does not parse/)
    const refused = dt(w.root, "exports")
    assert.notEqual(refused.code, 0)
    assert.equal(readFile(w.root, MANIFEST), "{ <<<<<<< ours")
    // a pulled manifest is read from disk on the next check — no compile in between
    handManifest(w.root, { people: { dana: { label: "Dana", from: "far" } } })
    write(w.root, { "data/tasks/t3.task.md": task("t3", { assignee: "people/dana" }) })
    assert.equal(dt(w.root, "check").code, 0)
  })

  // T6 (rnd/tests/dreamteamer/cr-dt-004-t4)
  test("stale: an unreferenced entry and an entry for an id now held are named; dt exports clears each, committed alone", () => {
    const w = vouched({ people: { idle: { label: "Idle", from: "far" } } })
    handManifest(w.root, { ...manifestOf(w.root), projects: { own: { label: "Own" } } })
    commitManifest(w.root)
    write(w.root, { "data/projects/own.project.md": "---\nname: Own\n---\n" })
    git(w.root, ["add", "data"])
    git(w.root, ["commit", "-qm", "own"])
    write(w.root, { "data/tasks/dirty.task.md": task("dirty") })
    const stale = dt(w.root, "check")
    assert.match(
      stale.stdout,
      /^⚠ dreamteamer-exports\.json is stale — .*people\/idle \(drop: no record references it\)/m
    )
    assert.match(stale.stdout, /projects\/own \(drop: held by the repo itself\)/)
    assert.equal(dt(w.root, "check", "--strict-export").code, 1)
    const before = head(w.root)
    assert.equal(dt(w.root, "exports").code, 0)
    assert.deepEqual(manifestOf(w.root), { people: { eli: { label: "Eli", from: "far" } } })
    assert.deepEqual(git(w.root, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n"), [MANIFEST])
    assert.equal(git(w.root, ["rev-parse", "HEAD~1"]).trim(), before)
    assert.match(git(w.root, ["status", "--porcelain"]), /^\?\? data\/tasks\/dirty\.task\.md$/m)
    assert.equal(dt(w.root, "check", "--strict-export").code, 0)
    const again = dt(w.root, "exports")
    assert.match(again.stdout, /exports manifest current/)
    assert.equal(git(w.root, ["rev-parse", "HEAD~1"]).trim(), before, "no second commit")
  })

  // T7 + T16 (rnd/tests/dreamteamer/cr-dt-004-t8)
  test("an entry naming this workspace as holder for an id it lacks is dangling and stale; dt exports drops it", () => {
    const w = ws({ files: { "data/tasks/t1.task.md": task("t1", { assignee: "people/ann" }) } })
    handManifest(w.root, { people: { ann: { label: "Ann", from: "w-pkg" } } })
    commitManifest(w.root)
    const res = dt(w.root, "check")
    assert.equal(res.code, 1, res.stdout)
    assert.match(
      res.stdout,
      /dangling reference "people\/ann" — no such record \(its holder w-pkg is read here and does not have it\)/
    )
    assert.match(
      res.stdout,
      /^⚠ dreamteamer-exports\.json is stale — people\/ann \(drop: its holder w-pkg no longer has it\)\. dt exports$/m
    )
    assert.equal(dt(w.root, "exports").code, 0)
    assert.equal(fs.existsSync(path.join(w.root, MANIFEST)), false)
  })

  // T13 (rnd/tests/dreamteamer/cr-dt-004-t2, -t4)
  test("a holder-less entry the workspace cannot resolve is kept as written", () => {
    const w = ws({ files: { "data/tasks/t1.task.md": task("t1", { assignee: "people/dana" }) } })
    handManifest(w.root, { people: { dana: { label: "From a stub" } } })
    commitManifest(w.root)
    const bytes = readFile(w.root, MANIFEST)
    assert.equal(dt(w.root, "exports").code, 0)
    assert.equal(readFile(w.root, MANIFEST), bytes)
    assert.doesNotMatch(dt(w.root, "check").stdout, /stale/)
  })

  // test review round 1, f1: a conflicted referrer never costs its entry
  test("while the only record naming an id does not parse, dt exports does not drop its entry", () => {
    const w = vouched()
    fs.writeFileSync(
      path.join(w.root, "data/tasks/t1.task.md"),
      "---\n<<<<<<< ours\nname: t1\nassignee: people/eli\n=======\nname: t1b\nassignee: people/eli\n>>>>>>> theirs\n---\n"
    )
    const res = dt(w.root, "exports", "--dry-run", "--json")
    assert.equal(res.code, 0, res.stderr)
    assert.deepEqual(JSON.parse(res.stdout).manifests[0].changes, [])
  })

  // T19 (rnd/tests/dreamteamer/cr-dt-004-t4)
  test("a data folder no collection reads makes the workspace incomplete: nothing dropped as unreferenced", () => {
    const w = ws({ files: { "data/projects/p.project.md": "---\nname: P\n---\n" } })
    handManifest(w.root, { people: { x: { label: "X", from: "far" } } })
    write(w.root, { "data/unknown/u1.thing.md": "---\nname: U\n---\n" })
    assert.doesNotMatch(dt(w.root, "check").stdout, /people\/x \(drop/, "a folder pulled after compile: incomplete")
    fs.rmSync(path.join(w.root, "data", "unknown"), { recursive: true })
    assert.match(dt(w.root, "check").stdout, /people\/x \(drop: no record references it\)/)
  })

  test("during a merge in a linked worktree the manifest is written and not committed", () => {
    const w = vouched({ people: { gone: { label: "G", from: "far" } } })
    // the fixture's own branch, never a literal: a runner whose git defaults to `master` (CI) has no `main`
    const base = git(w.root, ["branch", "--show-current"])
    git(w.root, ["branch", "side"])
    const wt = path.join(path.dirname(w.root), `${path.basename(w.root)}-wt`)
    git(w.root, ["worktree", "add", "-q", wt, "side"])
    try {
      fs.symlinkSync(path.join(w.root, "node_modules"), path.join(wt, "node_modules"))
      fs.writeFileSync(path.join(wt, "side.txt"), "side\n")
      git(wt, ["add", "side.txt"])
      git(wt, ["commit", "-qm", "side"])
      write(w.root, { "main.txt": "main\n" })
      git(w.root, ["add", "main.txt"])
      git(w.root, ["commit", "-qm", "main"])
      git(wt, ["merge", "--no-commit", "--no-ff", "-q", base])
      compileQuietly({ root: wt, pkg: w.ws.pkg })
      const before = head(wt)
      const res = dt(wt, "exports")
      assert.equal(res.code, 0, res.stderr)
      assert.match(res.stdout, /a merge is in progress — the manifest is written; git add it and conclude it/)
      assert.deepEqual(Object.keys(manifestOf(wt).people), ["eli"])
      assert.equal(head(wt), before)
    } finally {
      git(w.root, ["worktree", "remove", "--force", wt])
    }
  })

  // code review round 1, cherry-pick-case-missing
  test("during a cherry-pick the manifest is written and not committed", () => {
    const w = vouched({ people: { gone: { label: "G", from: "far" } } })
    git(w.root, ["checkout", "-q", "-b", "side"])
    write(w.root, { "c.txt": "side\n" })
    git(w.root, ["add", "c.txt"])
    git(w.root, ["commit", "-qm", "side"])
    git(w.root, ["checkout", "-q", "-"])
    write(w.root, { "c.txt": "main\n" })
    git(w.root, ["add", "c.txt"])
    git(w.root, ["commit", "-qm", "main"])
    try {
      git(w.root, ["cherry-pick", "side"])
    } catch {
      /* the conflict is the point */
    }
    assert.ok(fs.existsSync(path.join(w.root, ".git", "CHERRY_PICK_HEAD")))
    const before = head(w.root)
    const res = dt(w.root, "exports")
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, /a cherry-pick is in progress — the manifest is written/)
    assert.deepEqual(Object.keys(manifestOf(w.root).people), ["eli"])
    assert.equal(head(w.root), before)
  })

  test("an emptied manifest git never tracked is deleted, and nothing is committed", () => {
    const w = ws()
    handManifest(w.root, { people: { gone: { label: "G", from: "far" } } })
    const before = head(w.root)
    const res = dt(w.root, "exports")
    assert.equal(res.code, 0, res.stderr)
    assert.equal(fs.existsSync(path.join(w.root, MANIFEST)), false)
    assert.equal(head(w.root), before)
  })

  test("consistency: check names a manifest stale exactly when dt exports --dry-run reports a non-add change", () => {
    const w = vouched()
    const kinds = () =>
      JSON.parse(dt(w.root, "exports", "--dry-run", "--json").stdout).manifests[0].changes.map(c => c.kind)
    const stale = () => /is stale/.test(dt(w.root, "check").stdout)
    const states = [
      () => {},
      () => handManifest(w.root, { people: { eli: { label: "Eli", from: "far" }, gone: { label: "G", from: "far" } } }),
      () => dt(w.root, "exports"),
      () => handManifest(w.root, { people: { eli: { label: "Eli" } } }),
      () => handManifest(w.root, { people: { eli: { label: "Eli", from: "w-pkg" } } }),
    ]
    for (const s of states) {
      s()
      assert.equal(
        stale(),
        kinds().some(k => k !== "add")
      )
    }
  })
})

describe("dt get on an external id (cr-dt-004)", () => {
  // T9 (rnd/tests/dreamteamer/cr-dt-004-t7)
  test("exits 1 naming label and holder; --json carries $external; Store.external answers the same", () => {
    const w = ws({ files: { "data/tasks/t1.task.md": task("t1", { assignee: "people/dana" }) } })
    handManifest(w.root, { people: { dana: { label: "Dana", from: "hq-pkg" } } })
    const res = dt(w.root, "get", "people/dana")
    assert.equal(res.code, 1)
    assert.match(
      res.stderr,
      /people\/dana is not held here — external: "Dana", held by hq-pkg \(dreamteamer-exports\.json\)/
    )
    const json = dt(w.root, "get", "people/dana", "--json")
    assert.equal(json.code, 1)
    assert.deepEqual(JSON.parse(json.stdout).$external, {
      collection: "people",
      id: "dana",
      label: "Dana",
      from: "hq-pkg",
      manifest: MANIFEST,
    })
    assert.equal(dt(w.root, "get", "people/nobody").code, 1)
    assert.deepEqual(new Store(w.ws).external("people", "dana"), { label: "Dana", from: "hq-pkg", manifest: MANIFEST })
    write(w.root, { "data/people/dana.person.md": person("Dana") })
    assert.equal(new Store(w.ws).external("people", "dana"), null, "held here: live wins")
  })
})

describe("scripts/migrate-stubs.ts (cr-dt-004)", () => {
  const STUB = (name, extra = "") => `---\nname: ${name}\nstub: true\n${extra}---\nA body only the stub carried.\n`
  const migrateIn = async (root, opts) =>
    (await import("../../scripts/migrate-stubs.ts")).migrate(root, { ...opts, log: () => {} })

  // T11 (rnd/tests/dreamteamer/cr-dt-004-t6)
  test("dry run writes nothing; the run turns referenced stubs into entries and deletes unreferenced ones, in one commit, check clean", async () => {
    const w = ws({
      files: {
        "data/tasks/t1.task.md": task("t1", { assignee: "people/far" }),
        "data/people/far.person.md": STUB("Far (stub)"),
        "data/people/idle.person.md": STUB("Idle"),
      },
    })
    const before = head(w.root)
    const dry = await migrateIn(w.root, { dryRun: true })
    assert.equal(dry.length, 1)
    assert.equal(head(w.root), before)
    assert.equal(git(w.root, ["status", "--porcelain", "--", "data"]).trim(), "", "the dry run wrote nothing")
    await migrateIn(w.root, {})
    assert.deepEqual(manifestOf(w.root), { people: { far: { label: "Far (stub)" } } })
    assert.equal(git(w.root, ["rev-parse", "HEAD~1"]).trim(), before, "one commit")
    assert.equal(execGrep(w.root), "", "no file carries stub: true")
    assert.doesNotMatch(readFile(w.root, MANIFEST), /body only the stub/)
    const check = dt(w.root, "check")
    assert.equal(check.code, 0, check.stdout)
  })

  // code review round 1, migrate-git-add-absent-manifest
  test("a repo whose stubs are all unreferenced migrates to deletions in one commit, with no manifest", async () => {
    const w = ws({ files: { "data/people/idle.person.md": STUB("Idle") } })
    const before = head(w.root)
    await migrateIn(w.root, {})
    assert.equal(fs.existsSync(path.join(w.root, MANIFEST)), false)
    assert.equal(git(w.root, ["rev-parse", "HEAD~1"]).trim(), before)
    assert.match(git(w.root, ["show", "--name-status", "--format=", "HEAD"]), /^D\tdata\/people\/idle\.person\.md$/m)
    assert.equal(git(w.root, ["status", "--porcelain", "--", "data"]).trim(), "")
  })

  // code review round 1, stub-regex-crosses-frontmatter
  test("a record whose BODY quotes a stub is not a stub and is never deleted", async () => {
    const quoting = "---\nname: Quote\n---\nAn old placeholder looked like:\n\nstub: true\n---\n"
    const w = ws({ files: { "data/people/quote.person.md": quoting } })
    const report = await migrateIn(w.root, {})
    assert.deepEqual(report, [])
    assert.equal(readFile(w.root, "data/people/quote.person.md"), quoting)
  })

  // T19, the script half (rnd/tests/dreamteamer/cr-dt-004-t6)
  test("a stub in a workspace not read completely is never deleted without an entry", async () => {
    const w = ws({ files: { "data/people/bonly.person.md": STUB("Bonly"), "data/unknown/u1.thing.md": "---\n---\n" } })
    await migrateIn(w.root, {})
    assert.deepEqual(manifestOf(w.root), { people: { bonly: { label: "Bonly" } } })
  })
})

function execGrep(dir) {
  try {
    return git(dir, ["grep", "-l", "^stub: true", "--", "data"]).trim()
  } catch {
    return ""
  }
}
