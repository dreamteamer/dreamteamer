// test/integration/git-modules-hoist.test.js — tier 2: an HQ over two projects that both need one org layer.
//
// THE NPM MODEL. A clone's `git_modules` is one untyped list; npm's graph is typed, and that is what makes
// npm's eager, transitive install safe: a package drags in only what it NEEDS (`dependencies`), never what
// its author merely uses (`devDependencies`). Here the typed need is the clone's committed
// `dreamteamer-exports.json` (0.45.0): the packages that hold the ids its records name. So `dt install`
// reads, for each clone on disk, the entries of its `git_modules` that provide one of those packages — and
// only those — clones each once at the top-level `git_modules/<name>`, and lays a symlink under the clone.
// The root's own declaration overrides a clone's (npm `overrides`); two clones that disagree with each
// other, the root silent, get the first one hoisted and the second NESTED under its own declarer, as npm
// nests a second version. Nothing is ever refused: every disagreement is a line in `dt status`.
// Synthetic cast only: an `hq`, `project-a`, `project-b`, an `org` (package `@northwind/org`), `people`.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { workspace, git, dt, simpleCollection } from "../helpers/ws.js"
import { declaredGitModules, layerEntries } from "../../src/workspace.ts"
import { observeState } from "../../src/checkout.ts"

const ORG_PKG = "@northwind/org",
  PEOPLE_PKG = "people"
const manifest = (from, ids = { notes: ["2026-01-01--welcome"] }) =>
  JSON.stringify(
    {
      dreamteamer_exports: 1,
      references: Object.fromEntries(
        Object.entries(ids).map(([c, list]) => [c, Object.fromEntries(list.map(id => [id, { label: id, from }]))])
      ),
    },
    null,
    "\t"
  ) + "\n"
const note = title => `---\ntitle: ${title}\n---\n`

/** A remote the HQ can clone by URL: a workspace fixture (so it is a real workspace, `notes` and all)
 *  pushed into a bare repo under the HQ. `dependencies` is dropped from the pushed manifest so a clone of
 *  it never runs npm. Two commits: `v1` tags the first, the branch holds the second. */
function remote(hq, name, { pkgName = name, gitModules = {}, files = {}, gitignoreGitModules = true } = {}) {
  const w = workspace({ compile: false, pkg: { git_modules: gitModules } })
  const pkgFile = path.join(w.root, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
  delete pkg.dependencies
  pkg.name = pkgName
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
  if (!gitignoreGitModules)
    fs.writeFileSync(
      path.join(w.root, ".gitignore"),
      fs.readFileSync(path.join(w.root, ".gitignore"), "utf8").replace("git_modules/\n", "")
    )
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(w.root, path.dirname(rel)), { recursive: true })
    fs.writeFileSync(path.join(w.root, rel), body)
  }
  git(w.root, ["add", "-A"])
  git(w.root, ["commit", "-qm", name])
  git(w.root, ["tag", "v1"])
  fs.writeFileSync(path.join(w.root, "README.md"), `${name}, second commit\n`)
  git(w.root, ["add", "README.md"])
  git(w.root, ["commit", "-qm", `${name} two`])
  const branch = git(w.root, ["symbolic-ref", "--short", "HEAD"])
  const bare = path.join(hq.root, ".remotes", `${name}.git`)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  git(hq.root, ["clone", "--quiet", "--bare", w.root, bare])
  return {
    url: `file://${bare}`,
    ref: branch,
    v1: git(w.root, ["rev-parse", "v1"]),
    head: git(w.root, ["rev-parse", "HEAD"]),
    work: w.root,
  }
}

/** Push a change to a remote's working copy: a fresh clone, the edit, commit, push. */
function amend(hq, r, name, edit) {
  const work = path.join(hq.root, ".remotes", `${name}-work-${Math.random().toString(36).slice(2, 6)}`)
  git(hq.root, ["clone", "--quiet", r.url, work])
  git(work, ["config", "user.email", "test@example.invalid"])
  git(work, ["config", "user.name", "dreamteamer test"])
  edit(work)
  git(work, ["add", "-A"])
  git(work, ["commit", "-qm", "amend"])
  git(work, ["push", "--quiet", "origin", r.ref])
}

/** The cast: an org layer (`@northwind/org`) holding a note and a link, two projects each declaring the org
 *  for `notes` and — unless told otherwise — needing it, by a manifest naming `@northwind/org` as the holder
 *  of the note their records name. `people` is a second layer the org itself may need. */
function cast({
  hqDeclares = () => ({}),
  projectA = {},
  projectB = {},
  manifestA = ORG_PKG,
  manifestB = ORG_PKG,
  orgNeedsPeople = false,
} = {}) {
  const hq = workspace({ compile: false, collections: { links: simpleCollection({ storage: { suffix: "link" } }) } })
  const people = remote(hq, "people", {
    pkgName: PEOPLE_PKG,
    files: { "data/notes/2026-01-05--team.note.md": note("Team") },
  })
  const org = remote(hq, "org", {
    pkgName: ORG_PKG,
    gitModules: orgNeedsPeople ? { people: { url: people.url, ref: people.ref, records: ["notes"] } } : {},
    files: {
      "data/notes/2026-01-01--welcome.note.md": note("Welcome"),
      "data/links/engine.link.md": "---\nname: engine\n---\n",
      ...(orgNeedsPeople ? { "dreamteamer-exports.json": manifest(PEOPLE_PKG, { notes: ["2026-01-05--team"] }) } : {}),
    },
  })
  const project = (name, entry, from, extra) =>
    remote(hq, name, {
      gitModules: { org: { url: org.url, ref: org.ref, records: ["notes"], ...entry } },
      files: {
        [`data/notes/2026-01-0${name.endsWith("a") ? 2 : 3}--plan-${name.slice(-1)}.note.md`]: note(
          `Plan ${name.slice(-1)}`
        ),
        ...(from ? { "dreamteamer-exports.json": manifest(from) } : {}),
      },
      ...extra,
    })
  const a = project("project-a", projectA, manifestA)
  const b = project("project-b", projectB, manifestB, { gitignoreGitModules: false })
  const declare = map => {
    const pkgFile = path.join(hq.root, "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
    pkg.dreamteamer.git_modules = map
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
    hq.ws.pkg.dreamteamer.git_modules = map // what observeState reads
  }
  declare({
    "project-a": { url: a.url, ref: a.ref, records: ["notes"] },
    "project-b": { url: b.url, ref: b.ref, records: ["notes"] },
    ...hqDeclares(org),
  })
  return { hq, org, people, a, b, declare, at: (...p) => path.join(hq.root, ...p) }
}

const isLinkTo = (p, target) => {
  try {
    return fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p) === target
  } catch {
    return false
  }
}
const isClone = p => {
  try {
    return !fs.lstatSync(p).isSymbolicLink() && fs.existsSync(path.join(p, ".git"))
  } catch {
    return false
  }
}
const LINE = name => new RegExp(`^ {2}${name.padEnd(20)} (.*)$`, "m")
const layerLine = (stdout, name) => LINE(name).exec(stdout)?.[1] ?? `(no layer line for ${name} in:\n${stdout})`

describe("dt install satisfies what a clone NEEDS from the enclosing workspace — the npm model", () => {
  test("an HQ declaring only the projects ends with ONE org clone, a link under each project, and `-w` the project lists the org installed", () => {
    const c = cast()
    assert.deepEqual(
      observeState(c.hq.ws).gitModules,
      ["project-a", "project-b"],
      "before: only the HQ's own declarations are visible"
    )
    const res = dt(c.hq.root, "install")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.ok(isClone(c.at("git_modules", "org")), "the org is cloned once, at the top level")
    assert.match(res.stdout, /→ git_modules\/org \(\S+\) — for git_modules\/project-a, git_modules\/project-b/)
    for (const p of ["project-a", "project-b"]) {
      assert.ok(
        isLinkTo(c.at("git_modules", p, "git_modules", "org"), path.join("..", "..", "org")),
        `${p}: git_modules/org -> ../../org`
      )
      assert.match(res.stdout, new RegExp(`✔ git_modules/${p}/git_modules/org → git_modules/org`))
      assert.equal(git(c.at("git_modules", p), ["status", "--porcelain"]), "", `${p}: the link is invisible to git`)
    }
    // project-b's .gitignore does not cover git_modules/, so the link is excluded locally, never by a tracked file
    assert.match(
      fs.readFileSync(c.at("git_modules", "project-b", ".git", "info", "exclude"), "utf8"),
      /^git_modules\/org$/m
    )
    assert.ok(
      !fs.existsSync(c.at("git_modules", "project-a", ".git", "info", "exclude")) ||
        !/git_modules\/org/.test(fs.readFileSync(c.at("git_modules", "project-a", ".git", "info", "exclude"), "utf8")),
      "project-a already ignores git_modules/: nothing written"
    )
    // the HQ READS the hoisted layer: the projects' declarations said `notes`
    const list = dt(c.hq.root, "list", "notes")
    assert.equal(list.code, 0, list.stderr)
    for (const id of ["2026-01-01--welcome", "2026-01-02--plan-a", "2026-01-03--plan-b"])
      assert.ok(list.stdout.includes(id), `${id} is read in the HQ`)
    assert.deepEqual(
      layerEntries(c.hq.ws.pkg, c.hq.root).map(l => [l.name, l.records, l.via]),
      [
        ["project-a", ["notes"], []],
        ["project-b", ["notes"], []],
        ["org", ["notes"], ["git_modules/project-a", "git_modules/project-b"]],
      ]
    )
    const status = dt(c.hq.root, "status")
    assert.match(
      layerLine(status.stdout, "org"),
      /^git_modules @ [0-9a-f]{7} · records: notes · via git_modules\/project-a, git_modules\/project-b$/
    )
    // the project, compiled and asked on its own, finds its layer through the link
    assert.equal(dt(c.hq.root, "-w", "git_modules/project-a", "compile").code, 0)
    assert.match(
      layerLine(dt(c.hq.root, "-w", "git_modules/project-a", "status").stdout, "org"),
      /^git_modules @ [0-9a-f]{7} · records: notes$/
    )
    // the next run has nothing to do
    assert.deepEqual(observeState(c.hq.ws).gitModules, [])
    const again = dt(c.hq.root, "install")
    assert.equal(again.code, 0, again.stdout + again.stderr)
    assert.match(again.stdout, /git modules: nothing to restore/)
    assert.deepEqual(
      fs.readdirSync(c.at("git_modules")).sort(),
      ["org", "project-a", "project-b"],
      "people, which nobody needs, was never cloned"
    )
  })

  test("a clone with no dreamteamer-exports.json NEEDS nothing: its git_modules are its devDependencies, left uninstalled", () => {
    const c = cast({ manifestA: null, manifestB: null })
    const res = dt(c.hq.root, "install")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.deepEqual(fs.readdirSync(c.at("git_modules")).sort(), ["project-a", "project-b"])
    assert.ok(!fs.existsSync(c.at("git_modules", "project-a", "git_modules")), "no link either")
    assert.doesNotMatch(dt(c.hq.root, "status").stdout, LINE("org"))
    assert.equal(dt(c.hq.root, "-w", "git_modules/project-a", "compile").code, 0)
    assert.match(
      layerLine(dt(c.hq.root, "-w", "git_modules/project-a", "status").stdout, "org"),
      /^not installed — dreamteamer install/,
      "standing alone the project still declares it"
    )
  })

  test("only the clone whose manifest names the holder gets it: project-a needs the org, project-b only declares it", () => {
    const c = cast({ manifestB: null })
    assert.equal(dt(c.hq.root, "install").code, 0)
    assert.ok(isLinkTo(c.at("git_modules", "project-a", "git_modules", "org"), path.join("..", "..", "org")))
    assert.ok(!fs.existsSync(c.at("git_modules", "project-b", "git_modules", "org")))
    assert.match(layerLine(dt(c.hq.root, "status").stdout, "org"), /· via git_modules\/project-a$/)
  })

  test("a need is matched to an entry by package name, scoped or not; a holder no entry provides is said: `⚠ git_modules/project-a: dreamteamer-exports.json names @northwind/crm, which no git_modules entry of the clone provides`", () => {
    const c = cast({ manifestA: "@northwind/crm" })
    const res = dt(c.hq.root, "install")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.match(
      res.stderr,
      /⚠ git_modules\/project-a: dreamteamer-exports\.json names @northwind\/crm, which no git_modules entry of the clone provides/
    )
    assert.ok(
      !fs.existsSync(c.at("git_modules", "project-a", "git_modules", "org")),
      "project-a needs something else; the org it declares stays a devDependency"
    )
    assert.ok(
      isLinkTo(c.at("git_modules", "project-b", "git_modules", "org"), path.join("..", "..", "org")),
      "project-b needs @northwind/org and the entry `org` provides it"
    )
  })

  test("needs are transitive: the org needs `people`, so people is hoisted too and linked under the org", () => {
    const c = cast({ orgNeedsPeople: true })
    const res = dt(c.hq.root, "install")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.deepEqual(fs.readdirSync(c.at("git_modules")).sort(), ["org", "people", "project-a", "project-b"])
    assert.ok(isLinkTo(c.at("git_modules", "org", "git_modules", "people"), path.join("..", "..", "people")))
    assert.match(layerLine(dt(c.hq.root, "status").stdout, "people"), /· via git_modules\/org$/)
    assert.ok(dt(c.hq.root, "list", "notes").stdout.includes("2026-01-05--team"), "read here, two hops down")
  })

  test("two clones disagreeing with each other, the root silent: the first is hoisted, the second is NESTED under its declarer — never refused", () => {
    const c = cast()
    const other = remote(c.hq, "other-org", {
      pkgName: ORG_PKG,
      files: { "data/notes/2026-01-01--welcome.note.md": note("Welcome, elsewhere") },
    })
    amend(c.hq, c.b, "project-b", work => {
      const pkgFile = path.join(work, "package.json")
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
      pkg.dreamteamer.git_modules.org.url = other.url
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
    })
    const res = dt(c.hq.root, "install")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.ok(isClone(c.at("git_modules", "org")), "project-a's org at the top")
    assert.equal(git(c.at("git_modules", "org"), ["remote", "get-url", "origin"]), c.org.url)
    assert.ok(isClone(c.at("git_modules", "project-b", "git_modules", "org")), "project-b's own org, nested")
    assert.equal(
      git(c.at("git_modules", "project-b", "git_modules", "org"), ["remote", "get-url", "origin"]),
      other.url
    )
    assert.match(
      res.stdout,
      new RegExp(
        `… cloning ${other.url} → git_modules/project-b/git_modules/org \\(\\S+\\) — nested: git_modules/org is ${c.org.url}`
      )
    )
    const status = dt(c.hq.root, "status")
    assert.match(layerLine(status.stdout, "org"), /· via git_modules\/project-a$/)
    assert.match(
      status.stdout,
      new RegExp(`^ {4}↳ org nested @ [0-9a-f]{7} — ${other.url} \\(\\S+\\); git_modules/org is ${c.org.url}`, "m"),
      status.stdout
    )
    assert.equal(
      git(c.at("git_modules", "project-b"), ["status", "--porcelain"]),
      "",
      "the nested clone is excluded in project-b"
    )
    const again = dt(c.hq.root, "install")
    assert.match(again.stdout, /git modules: nothing to restore/)
    assert.deepEqual(observeState(c.hq.ws).gitModules, [])
  })

  test("the root's declaration OVERRIDES a clone's, ref and url alike: `⚠ git_modules/org: this workspace's declaration overrides git_modules/project-a (ref …), git_modules/project-b (url …)`", () => {
    const c = cast({ hqDeclares: org => ({ org: { url: org.url, ref: "v1", records: ["notes"] } }) })
    // project-b spells the same remote differently — an ssh host alias does exactly this
    const alias = c.org.url.replace("file://", "file://localhost")
    amend(c.hq, c.b, "project-b", work => {
      const pkgFile = path.join(work, "package.json")
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
      pkg.dreamteamer.git_modules.org = { url: alias, ref: "v1", records: ["notes"] }
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
    })
    const res = dt(c.hq.root, "install")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.equal(
      git(c.at("git_modules", "org"), ["rev-parse", "HEAD"]),
      c.org.v1,
      "the HQ's v1, not project-a's branch"
    )
    assert.match(
      res.stderr,
      new RegExp(
        `⚠ git_modules/org: this workspace's declaration overrides git_modules/project-a \\(ref ${c.org.ref}\\), git_modules/project-b \\(url ${alias}\\)`
      )
    )
    for (const p of ["project-a", "project-b"])
      assert.ok(
        isLinkTo(c.at("git_modules", p, "git_modules", "org"), path.join("..", "..", "org")),
        `${p} is linked to the root's clone, not nested`
      )
    assert.match(
      layerLine(dt(c.hq.root, "status").stdout, "org"),
      new RegExp(
        `· records: notes · overrides git_modules/project-a \\(ref ${c.org.ref}\\), git_modules/project-b \\(url ${alias}\\)$`
      )
    )
    assert.deepEqual(
      declaredGitModules(c.hq.ws.pkg, c.hq.root).mismatches.map(m => [m.name, m.by, m.what, m.theirs]),
      [
        ["org", "git_modules/project-a", "ref", c.org.ref],
        ["org", "git_modules/project-b", "url", alias],
      ]
    )
  })

  test("an HQ that also declares the layer: the union of records is read, the HQ's list first", () => {
    const c = cast({ hqDeclares: org => ({ org: { url: org.url, ref: org.ref, records: ["links"] } }) })
    assert.equal(dt(c.hq.root, "install").code, 0)
    const entry = layerEntries(c.hq.ws.pkg, c.hq.root).find(l => l.name === "org")
    assert.deepEqual(
      [entry.records, entry.via],
      [
        ["links", "notes"],
        ["git_modules/project-a", "git_modules/project-b"],
      ]
    )
    assert.ok(dt(c.hq.root, "list", "links").stdout.includes("engine"), "read because the HQ said so")
    assert.ok(dt(c.hq.root, "list", "notes").stdout.includes("2026-01-01--welcome"), "read because a project said so")
    assert.match(
      layerLine(dt(c.hq.root, "status").stdout, "org"),
      /^git_modules @ [0-9a-f]{7} · records: links, notes · via git_modules\/project-a, git_modules\/project-b$/
    )
  })

  test("a nested declaration naming no records reads every shared collection of a workspace clone, as a top-level one does", () => {
    const c = cast({ projectA: { records: undefined } })
    assert.equal(dt(c.hq.root, "install").code, 0)
    assert.equal(
      layerEntries(c.hq.ws.pkg, c.hq.root).find(l => l.name === "org").records,
      null,
      "project-a names none: the widest reading wins the union"
    )
    assert.ok(dt(c.hq.root, "list", "links").stdout.includes("engine"))
  })

  test("a project cloned on its own is unchanged: it is the root, and everything it declares lands in its own git_modules/ as clones", () => {
    const c = cast({ manifestA: null })
    const alone = path.join(c.hq.root, ".alone")
    git(c.hq.root, ["clone", "--quiet", c.a.url, alone])
    fs.mkdirSync(path.join(alone, "node_modules"))
    fs.symlinkSync(
      fs.realpathSync(path.join(c.hq.root, "node_modules", "dreamteamer")),
      path.join(alone, "node_modules", "dreamteamer")
    )
    const res = dt(alone, "install")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.ok(
      isClone(path.join(alone, "git_modules", "org")),
      "a real clone, manifest or no manifest: the root installs all it declares"
    )
    assert.doesNotMatch(res.stdout, / — for /, "no declarer but itself")
  })

  test("a clone of its own standing where the link belongs is left as it is, and said", () => {
    const c = cast()
    assert.equal(dt(c.hq.root, "install").code, 0)
    const at = c.at("git_modules", "project-a", "git_modules", "org")
    fs.unlinkSync(at)
    git(c.hq.root, ["clone", "--quiet", c.org.url, at])
    fs.writeFileSync(path.join(at, "scratch.txt"), "local work\n")
    assert.deepEqual(observeState(c.hq.ws).gitModules, [], "satisfied in its own way: nothing to do")
    const status = dt(c.hq.root, "status")
    assert.match(
      status.stdout,
      /^ {4}↳ org its own clone @ [0-9a-f]{7}, not a link to git_modules\/org$/m,
      status.stdout
    )
    assert.ok(fs.existsSync(path.join(at, "scratch.txt")), "left alone")
  })

  test("dt update pulls a hoisted clone forward too", () => {
    const c = cast()
    assert.equal(dt(c.hq.root, "install").code, 0)
    amend(c.hq, c.org, "org", work =>
      fs.writeFileSync(path.join(work, "data", "notes", "2026-01-04--later.note.md"), note("Later"))
    )
    const res = dt(c.hq.root, "update")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /✔ git_modules\/org [0-9a-f]{7} → [0-9a-f]{7}/)
    assert.ok(dt(c.hq.root, "list", "notes").stdout.includes("2026-01-04--later"))
  })
})

describe("declaredGitModules reads the declarations, then what each clone on disk NEEDS", () => {
  test("with no root it is the workspace's own map, validated as before", () => {
    const pkg = {
      dreamteamer: { git_modules: { org: { url: "u", records: ["notes"] }, pa: { url: "v", module: true } } },
    }
    const { map, nested, mismatches } = declaredGitModules(pkg)
    assert.deepEqual(
      [...map].map(([n, e]) => [n, e.url, e.ref, e.records, e.module, e.declarers]),
      [
        ["org", "u", "main", ["notes"], false, [null]],
        ["pa", "v", "main", undefined, true, [null]],
      ]
    )
    assert.deepEqual([nested, mismatches], [[], []])
    assert.throws(
      () => declaredGitModules({ dreamteamer: { git_modules: { x: { url: "u", module: "yes" } } } }),
      /git_modules\.x\.module must be true or false/
    )
    assert.throws(
      () => declaredGitModules({ dreamteamer: { git_modules: { x: { url: "u", records: [] } } } }),
      /git_modules\.x\.records must be a non-empty list/
    )
  })
  test("a nested `module: true` is not hoisted as a module — which modules compile here is this workspace's call", () => {
    const c = cast({ projectA: { module: true } })
    assert.equal(dt(c.hq.root, "install").code, 0)
    assert.equal(layerEntries(c.hq.ws.pkg, c.hq.root).find(l => l.name === "org").module, false)
  })
})

// ---- 0.46.1: what the first architecture review of 0.46.0 found in the nesting and linking paths ----
describe("0.46.1 — a link is never mistaken for a clone, a link resolves at any depth, compile follows a restored layer", () => {
  test("a declarer whose declaration diverges AFTER the first install gets its own nested clone; the shared top clone is never re-pointed through the link", () => {
    const c = cast()
    assert.equal(dt(c.hq.root, "install").code, 0)
    assert.ok(isLinkTo(c.at("git_modules", "project-b", "git_modules", "org"), path.join("..", "..", "org")))
    amend(c.hq, c.b, "project-b", work => {
      const pkgFile = path.join(work, "package.json")
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
      pkg.dreamteamer.git_modules.org.ref = "v1"
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
    })
    assert.equal(dt(c.hq.root, "update", "project-b").code, 0, "project-b pulls its new declaration")
    const res = dt(c.hq.root, "install")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.equal(
      git(c.at("git_modules", "org"), ["rev-parse", "HEAD"]),
      c.org.head,
      "the top clone stays on the branch project-a and the HQ read"
    )
    assert.ok(
      isClone(c.at("git_modules", "project-b", "git_modules", "org")),
      "project-b now has a clone of its own where the link was"
    )
    assert.equal(git(c.at("git_modules", "project-b", "git_modules", "org"), ["rev-parse", "HEAD"]), c.org.v1)
    assert.match(res.stdout, /— nested: git_modules\/org is /)
    assert.deepEqual(observeState(c.hq.ws).gitModules, [], "settled")
    assert.match(dt(c.hq.root, "install").stdout, /git modules: nothing to restore/)
  })

  test("a need declared by a NESTED copy is linked at the right depth: the link resolves to the top-level clone", () => {
    const c = cast()
    const other = remote(c.hq, "other-org", {
      pkgName: ORG_PKG,
      gitModules: { people: { url: c.people.url, ref: c.people.ref, records: ["notes"] } },
      files: {
        "data/notes/2026-01-01--welcome.note.md": note("Welcome, elsewhere"),
        "dreamteamer-exports.json": manifest(PEOPLE_PKG, { notes: ["2026-01-05--team"] }),
      },
    })
    amend(c.hq, c.b, "project-b", work => {
      const pkgFile = path.join(work, "package.json")
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
      pkg.dreamteamer.git_modules.org.url = other.url
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
    })
    const res = dt(c.hq.root, "install")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    const nested = c.at("git_modules", "project-b", "git_modules", "org")
    assert.ok(isClone(nested), "project-b's org is nested")
    assert.ok(isClone(c.at("git_modules", "people")), "the nested copy's need is hoisted to the top")
    const link = path.join(nested, "git_modules", "people")
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.ok(fs.existsSync(link), `the link resolves (target ${fs.readlinkSync(link)})`)
    assert.equal(fs.realpathSync(link), fs.realpathSync(c.at("git_modules", "people")))
    assert.deepEqual(observeState(c.hq.ws).gitModules, [], "settled")
    assert.match(dt(c.hq.root, "install").stdout, /git modules: nothing to restore/)
  })

  test("compile is re-run after the git modules step restores a layer, so the runtime knows the layer's package", () => {
    const c = cast()
    assert.equal(dt(c.hq.root, "compile").code, 0, "compiled while its layers are not installed")
    const res = dt(c.hq.root, "install")
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /▶ compile: git modules were just restored/)
    assert.doesNotMatch(res.stdout, /✔ compile: fresh/)
    const manifest = fs.readFileSync(c.at(".dreamteamer", "manifest.yaml"), "utf8")
    assert.match(
      manifest,
      new RegExp(`package: '?${ORG_PKG}'?`),
      "the hoisted org layer is compiled in with its package name"
    )
  })
})
