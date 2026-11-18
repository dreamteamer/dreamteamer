// Held-out (0.49.1, rnd/tests/dreamteamer/held-out-0491-exports-write): `dt set` and `dt add` accept the
// references `dt check` accepts — an id no root holds that the REFERRING record's repo's exports manifest
// vouches for — and nothing more: many-valued fields, soft references, the wrong target collection, a
// manifest that does not parse, and a layer record written from a reader. Synthetic fixtures only.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { workspace, compileQuietly, git, dt } from "../helpers/ws.ts"
import { serializeExports } from "../../src/lib/exports.ts"

const MANIFEST = "dreamteamer-exports.json"
const PEOPLE =
  'name: people\nstorage:\n  suffix: person\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n'
const PROJECTS =
  'name: projects\nstorage:\n  suffix: project\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n'
const TASKS =
  'name: tasks\nstorage:\n  suffix: task\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n' +
  "  assignee:\n    type: people\n  watchers:\n    type: people\n    many: true\n  mentor:\n    type: people\n    soft: true\n  project:\n    type: projects\n"

const write = (dir, files) => {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
}
const rec = fields =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n`
function commitAll(dir, msg) {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    git(dir, ["init", "-q"])
    git(dir, ["config", "user.email", "test@example.invalid"])
    git(dir, ["config", "user.name", "dreamteamer test"])
  }
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", msg, "--allow-empty"])
}
/** A workspace named `pkg` whose shapes come from a bundle clone `org`, holding `files`. */
function ws({ pkg, files = {} }) {
  const w = workspace({ compile: false })
  write(path.join(w.root, "git_modules", "org"), {
    "package.json": JSON.stringify({ name: "org", version: "1.0.0", dreamteamer: {} }),
    "collections/people.collection.yaml": PEOPLE,
    "collections/projects.collection.yaml": PROJECTS,
    "collections/tasks.collection.yaml": TASKS,
  })
  commitAll(path.join(w.root, "git_modules", "org"), "org")
  const pkgPath = path.join(w.root, "package.json")
  const m = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  m.name = pkg
  m.dreamteamer.git_modules = { org: { url: "x", ref: "main" } }
  fs.writeFileSync(pkgPath, JSON.stringify(m, null, "\t") + "\n")
  write(w.root, files)
  commitAll(w.root, "ws")
  w.ws.pkg = m
  compileQuietly(w.ws)
  return w
}
/** R reads `w` as the layer `w`: a copy of its committed data and manifest, never its own layers. */
function readerOf(w, { pkg, files = {} }) {
  const r = ws({ pkg, files })
  const dir = path.join(r.root, "git_modules", "w")
  fs.mkdirSync(dir, { recursive: true })
  fs.cpSync(path.join(w.root, "package.json"), path.join(dir, "package.json"))
  fs.cpSync(path.join(w.root, "data"), path.join(dir, "data"), { recursive: true })
  fs.cpSync(path.join(w.root, MANIFEST), path.join(dir, MANIFEST))
  write(dir, { "modules/default/package.json": JSON.stringify({ name: "default", dreamteamer: {} }) })
  commitAll(dir, "w")
  const pkgPath = path.join(r.root, "package.json")
  const m = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  m.dreamteamer.git_modules.w = { url: "x", ref: "main" }
  fs.writeFileSync(pkgPath, JSON.stringify(m, null, "\t") + "\n")
  r.ws.pkg = m
  compileQuietly(r.ws)
  return r
}
const bytes = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8")
const T1 = "data/tasks/t1.task.md"
const VOUCHED = { people: { dana: { label: "Dana", from: "hq-pkg" } } }

describe("held-out 0.49.1 — a write accepts exactly the references check accepts", () => {
  test("many-valued: vouched + held is written; vouched + unknown is refused naming the unknown one, nothing written", () => {
    const w = ws({
      pkg: "w-pkg",
      files: {
        "data/people/bo.person.md": rec({ name: "Bo" }),
        [T1]: rec({ name: "t1" }),
        "data/tasks/t2.task.md": rec({ name: "t2" }),
        [MANIFEST]: serializeExports(VOUCHED),
      },
    })
    const ok = dt(w.root, "set", "tasks/t1", "watchers=people/dana,people/bo")
    assert.equal(ok.code, 0, ok.stderr + ok.stdout)
    assert.match(bytes(w.root, T1), /people\/dana/)
    assert.match(bytes(w.root, T1), /people\/bo/)
    const added = dt(w.root, "add", "tasks", "--name", "t3", "--watchers", "people/dana,people/bo")
    assert.equal(added.code, 0, added.stderr + added.stdout)
    const before = bytes(w.root, "data/tasks/t2.task.md")
    const bad = dt(w.root, "set", "tasks/t2", "watchers=people/dana,people/nobody")
    assert.equal(bad.code, 1, bad.stderr + bad.stdout)
    assert.match(bad.stderr, /dangling reference "people\/nobody"/)
    assert.doesNotMatch(bad.stderr, /"people\/dana"/, "the vouched one is not the refusal")
    assert.equal(bytes(w.root, "data/tasks/t2.task.md"), before, "nothing written")
    const ck = dt(w.root, "check")
    assert.equal(ck.code, 0, ck.stdout)
  })

  test("soft: an unvouched id on a soft reference is still accepted; wrong collection: a vouched id is still refused", () => {
    const w = ws({ pkg: "w-pkg", files: { [T1]: rec({ name: "t1" }), [MANIFEST]: serializeExports(VOUCHED) } })
    const soft = dt(w.root, "set", "tasks/t1", "mentor=people/ghost")
    assert.equal(soft.code, 0, soft.stderr + soft.stdout)
    assert.match(bytes(w.root, T1), /mentor: people\/ghost/)
    const before = bytes(w.root, T1)
    const wrong = dt(w.root, "set", "tasks/t1", "project=people/dana")
    assert.equal(wrong.code, 1, wrong.stderr + wrong.stdout)
    assert.match(wrong.stderr, /must target collection "projects"/)
    assert.equal(bytes(w.root, T1), before, "nothing written")
  })

  test("a manifest that does not parse: the write refuses naming the file and never accepts", () => {
    const w = ws({
      pkg: "w-pkg",
      files: {
        [T1]: rec({ name: "t1" }),
        [MANIFEST]: '{ "dreamteamer_exports": 1, "references": { "people": { "dana": \n',
      },
    })
    const before = bytes(w.root, T1)
    const r = dt(w.root, "set", "tasks/t1", "assignee=people/dana")
    assert.notEqual(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stderr, /dreamteamer-exports\.json/)
    assert.equal(bytes(w.root, T1), before, "nothing written")
    const a = dt(w.root, "add", "tasks", "--name", "t9", "--assignee", "people/dana")
    assert.notEqual(a.code, 0, a.stderr + a.stdout)
    assert.equal(fs.existsSync(path.join(w.root, "data/tasks/t9.task.md")), false)
  })

  test("a reader: a layer record is judged against the layer's manifest, a new record against the reader's own", () => {
    const w = ws({ pkg: "w-pkg", files: { [T1]: rec({ name: "t1" }), [MANIFEST]: serializeExports(VOUCHED) } })
    const r = readerOf(w, {
      pkg: "r-pkg",
      files: { [MANIFEST]: serializeExports({ people: { zed: { label: "Zed", from: "far-pkg" } } }) },
    })
    const layerFile = path.join("git_modules", "w", T1)
    const viaLayer = dt(r.root, "set", "tasks/t1", "assignee=people/dana")
    assert.equal(viaLayer.code, 0, viaLayer.stderr + viaLayer.stdout)
    assert.match(bytes(r.root, layerFile), /assignee: people\/dana/)
    const before = bytes(r.root, layerFile)
    const notTheLayers = dt(r.root, "set", "tasks/t1", "assignee=people/zed")
    assert.equal(notTheLayers.code, 1, notTheLayers.stderr + notTheLayers.stdout)
    assert.match(notTheLayers.stderr, /dangling reference "people\/zed"/)
    assert.equal(bytes(r.root, layerFile), before, "nothing written")
    const own = dt(r.root, "add", "tasks", "--name", "local", "--assignee", "people/zed")
    assert.equal(own.code, 0, own.stderr + own.stdout)
    const notOurs = dt(r.root, "add", "tasks", "--name", "local2", "--assignee", "people/dana")
    assert.equal(notOurs.code, 1, notOurs.stderr + notOurs.stdout)
    assert.match(notOurs.stderr, /dangling reference "people\/dana"/)
  })
})
