// The released engine's API v1 over this engine (src/api.js): the names the protocol host and the web module call,
// on throw-away workspaces, and the presentation the released engine computes, pinned.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { compile } from "../src/compile/compile.ts"
import { buildModel } from "../src/model/buildModel.ts"
import { add } from "../src/store/add.ts"
import * as api from "../src/api.js"
import { publishedWorkspace, put, workspace } from "./helpers.ts"

/** the invented workspace, declared a workspace, with a task and a user */
function seeded() {
  const root = workspace()
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  pkg.dreamteamer = { namespaces: ["lab"], vars: ["FILES"] }
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg))
  const m = buildModel(root)
  add(m, "users", { name: "Dana Oren" })
  add(m, "tasks", { name: "Brief Dana", assignee: "users/dana-oren", status: "done", tags: ["a", "b"] }, "brief-dana")
  add(m, "tasks", { name: "Call Sam", due: "2026-09-01" }, "call-sam")
  return root
}

test("the entry names its version and opens the workspace a folder is in", async () => {
  const root = seeded()
  assert.equal(api.apiVersion, 1)
  assert.equal(api.engineVersion(), "0.49.1")
  const ws = await api.openWorkspace(join(root, "modules", "local"))
  assert.equal(ws.root, root)
  assert.deepEqual(ws.extensions, [])
  assert.deepEqual(api.namespaces(root), ["lab"])
})

test("the Store reads records in the released shapes, and refuses an unknown collection or record", () => {
  const root = seeded()
  const store = new api.Store({ root })
  assert.ok(store.descriptors instanceof Map && store.descriptors.has("tasks") && store.descriptors.has("skills"))
  assert.throws(() => store.descriptor("nope"), /unknown collection "nope" \(known: /)
  const r = store.read("tasks", "brief-dana")
  assert.equal(r.fields.name, "Brief Dana")
  assert.equal(r.file, join(root, "data/tasks/brief-dana.task.md"))
  assert.throws(() => store.read("tasks", "nobody"), /no such record/)
  assert.deepEqual(
    [...store.readAll("tasks")].map((t) => t.id),
    ["brief-dana", "call-sam"],
  )
  assert.deepEqual(store.locate("tasks", "call-sam"), { file: "data/tasks/call-sam.task.md", repo: "." })
  assert.deepEqual(store.recordDirs(store.descriptor("tasks")), [join(root, "data/tasks")])
  assert.equal(store.createdOf("tasks", "x", { created: "2026-01-01" }), "2026-01-01")
  // a source kind's record is read from the model, at the file the released engine compiles it to
  assert.equal(store.read("collections", "tasks").file, join(root, ".dreamteamer/collections/tasks.collection.yaml"))
  assert.equal(api.isRuntime(store.descriptor("collections")), true)
  assert.deepEqual(api.storageOf(store.descriptor("tasks")).roots, [{ path: "data/tasks", repo: "." }])
  assert.equal(api.bodyField(store.descriptor("tasks")), "notes")
})

test("references split at a declared namespace, and filters and sorts answer as the released engine's", () => {
  assert.deepEqual(api.parseRef("lab/samples/s-1", ["lab"]), { collection: "lab/samples", id: "s-1" })
  assert.deepEqual(api.parseRef("tasks/a/b", ["lab"]), { collection: "tasks", id: "a/b" })
  assert.equal(api.parseRef("lab/samples", ["lab"]), null)
  const row = { status: "done", tags: ["a", "b"], due: "2026-09-01", n: 5 }
  const yes = [
    { status: { _eq: "done" } },
    { tags: { _eq: "a" } },
    { tags: { _in: ["z", "b"] } },
    { due: { _lt: "2026-09-02T00:00:00Z" } },
    { n: { _between: [1, 9] } },
    { _or: [{ status: "todo" }, { n: { _gte: "5" } }] },
    { missing: { _null: true } },
    { status: { _icontains: "DON" } },
  ]
  for (const f of yes) assert.equal(api.matchesFilter(row, f), true, JSON.stringify(f))
  for (const f of [{ status: { _neq: "done" } }, { status: { _nope: 1 } }, { due: { _gt: "$yesterday" } }])
    assert.equal(api.matchesFilter(row, f), false, JSON.stringify(f))
  assert.deepEqual([...api.unknownOperators({ a: { _nope: 1 }, _and: [{ b: { _eq: 1 } }] })], ["_nope"])
  const rows = [{ s: "done" }, { s: "" }, { s: "todo" }, { s: "other" }]
  const schema = { properties: { s: { enum: ["todo", "done"] } } }
  assert.deepEqual(
    api.sortRows(rows, "s", schema).map((t) => t.s),
    ["", "todo", "done", "other"],
  )
  assert.deepEqual(
    api.sortRows([{ d: "2026-01-02T00:00:00+03:00" }, { d: "2026-01-01T23:00:00Z" }], "-d").map((t) => t.d),
    ["2026-01-01T23:00:00Z", "2026-01-02T00:00:00+03:00"],
  )
})

test("a reference is followed one hop by a filter, and values and commands are counted from the records", () => {
  const root = seeded()
  const p = (path: string, text: string) => put(root, `modules/local/${path}`, text)
  p("commands/review.command.md", "---\nname: review\ndescription: review it\n---\nreview.\n")
  p(
    "command-bindings/review--tasks.command-binding.yaml",
    "command: commands/review\ncollection: collections/tasks\navailable_when: {status: {_eq: todo}}\ndone_when: {status: {_eq: done}}\n",
  )
  const store = new api.Store({ root })
  const resolve = api.recordResolver(store)
  assert.equal(
    api.matchesFilter({ assignee: "users/dana-oren" }, { assignee: { name: { _eq: "Dana Oren" } } }, resolve),
    true,
  )
  assert.equal(
    api.matchesFilter({ assignee: "users/nobody" }, { assignee: { name: { _nnull: true } } }, resolve),
    false,
  )
  const v = api.distinctValues(store, "tasks", "tags")
  assert.deepEqual(v.values, [
    { value: "a", count: 1 },
    { value: "b", count: 1 },
  ])
  assert.equal(api.distinctValues(store, "tasks", "status").source, "enum")
  assert.throws(() => api.distinctValues(store, "tasks", "nope"), /unknown field "nope"/)
  const c = api.commandsFor(store, "tasks", ["brief-dana", "call-sam", "ghost"])
  assert.equal(c.commands.length, 1)
  assert.deepEqual(c.commands[0].states, { "brief-dana": "done", "call-sam": "available", ghost: "not-applicable" })
  assert.equal(c.commands[0].invocation, "/review tasks/call-sam")
})

test("templates render declared variables from .env, and refuse the rest", () => {
  const root = seeded()
  writeFileSync(join(root, ".env"), 'FILES="/files"\nEMPTY=\n')
  const ws = { root, pkg: JSON.parse(readFileSync(join(root, "package.json"), "utf8")) }
  const ctx = api.envContext(ws)
  assert.equal(api.renderTemplate("${env:FILES}/a ${OTHER}", ctx), "/files/a ${OTHER}")
  assert.equal(api.renderTemplate("${workspaceFolder}", ctx), root)
  assert.throws(() => api.renderTemplate("${env:EMPTY}", ctx), /not declared in dreamteamer.vars/)
  assert.throws(() => api.renderTemplate("${foo:bar}", ctx), /not a dreamteamer variable/)
})

test("presentation is the released engine's, row for row, over the published modules", async () => {
  const root = publishedWorkspace()
  compile(buildModel(root))
  const released = await import("../node_modules/dreamteamer/src/api.js")
  const ours = api.presentation(new api.Store({ root }).descriptors)
  // the released engine's presentation of the same compiled layout, every collection, field and relation
  assert.deepEqual(ours, released.presentation(released.loadDescriptors(root)))
  // and the row its own compile gives tasks, pinned in published.test.ts
  const tasks = ours.collections.find((t) => t.collection === "tasks")
  assert.deepEqual(tasks?.list, {
    layout: "table",
    columns: ["name", "status", "assignee", "created", "due", "project", "tags"],
    sort: "-created",
  })
  assert.equal(api.readManifest(root) !== null && api.staleness(root).compiled, true)
  assert.deepEqual([...new api.Store({ root }).readAll("assets")], [])
})

test("records are written through the Store, and a refusal carries its reasons in its message", () => {
  const root = seeded()
  const store = new api.Store({ root })
  const made = store.add("tasks", { name: "Plan the launch", status: "todo" }, { id: undefined })
  assert.match(made.id, /plan-the-launch$/)
  assert.equal(made.file, join(root, `data/tasks/${made.id}.task.md`))
  assert.deepEqual(store.add("tasks", { name: "Named" }, { id: "named" }).id, "named")
  assert.throws(() => store.add("tasks", { name: "Bad", status: "nope" }), /rejected — nothing written: .*status/)
  assert.deepEqual(store.set("tasks", "named", { status: "done", due: null }), { id: "named" })
  assert.equal(store.read("tasks", "named").fields.status, "done")
  assert.throws(() => store.set("tasks", "named", { estimate: 0 }), /rejected — nothing written: .*estimate/)
  assert.throws(() => store.rm("users", "dana-oren"), /is referenced by/)
  assert.deepEqual(store.rm("tasks", "named"), { id: "named", inboundIgnored: [] })
  assert.throws(() => store.read("tasks", "named"), /no such record/)
  assert.throws(() => store.set("collections", "tasks", { description: "x" }), /read-only/)
})

test("a record's history, a commit's patch and a revert are read from git", () => {
  const root = seeded()
  const g = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=Dana Oren", "-c", "user.email=dana@northwind.example", ...a], { cwd: root })
  g("init", "-q")
  g("add", "-A")
  g("commit", "-qm", "first")
  const store = new api.Store({ root })
  store.set("tasks", "call-sam", { status: "done" })
  g("commit", "-qam", "done")
  const h = api.history(store, "tasks", "call-sam")
  assert.deepEqual(
    h.map((t) => t.subject),
    ["done", "first"],
  )
  assert.equal(h[0].author, "Dana Oren")
  assert.match(api.historyDiff(store, "tasks", "call-sam", h[0].hash.slice(0, 7)).diff, /\+status: done/)
  assert.throws(() => api.historyDiff(store, "tasks", "call-sam", "--output=x"), /not a commit id/)
  assert.deepEqual(store.revert("tasks", "call-sam", h[1].hash).reverted, true)
  assert.equal(store.read("tasks", "call-sam").fields.status, "todo")
  assert.deepEqual(store.revert("tasks", "call-sam", h[1].hash), { id: "call-sam", reverted: false })
})

test("a rename moves the record and rewrites who names it; a position key falls between its neighbours", () => {
  const root = seeded()
  const store = new api.Store({ root })
  const r = store.rename("users", "dana-oren", "dana")
  assert.equal(r.id, "dana")
  assert.deepEqual(r.touched, ["data/tasks/brief-dana.task.md"])
  assert.equal(store.read("tasks", "brief-dana").fields.assignee, "users/dana")
  assert.deepEqual(store.read("users", "dana").fields.tasks, ["tasks/brief-dana"])
  assert.throws(() => store.read("users", "dana-oren"), /no such record/)
  assert.throws(() => store.rename("users", "dana", "dana"), /already exists/)
  const rows = [
    { id: "a", key: "c" },
    { id: "b", key: "d" },
    { id: "c", key: "" },
  ]
  const keys = [
    api.placementKey(rows, "c", { top: true }),
    api.placementKey(rows, "c", { after: "a" }),
    api.placementKey(rows, "c", { bottom: true }),
  ]
  assert.ok(keys[0] < "c" && "c" < keys[1] && keys[1] < "d" && "d" < keys[2], keys.join(" "))
  assert.throws(() => api.placementKey(rows, "a", { after: "c" }), /no sort value/)
})

test("pending records are listed and committed, each file named, nothing else swept in", () => {
  const root = seeded()
  const g = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=Dana Oren", "-c", "user.email=dana@northwind.example", ...a], {
      cwd: root,
    }).toString()
  g("init", "-q")
  g("add", "-A")
  g("commit", "-qm", "first")
  const store = new api.Store({ root })
  store.set("tasks", "call-sam", { status: "done" })
  store.add("tasks", { name: "New one" }, { id: "new-one" })
  writeFileSync(join(root, "stray.txt"), "not a record\n")
  const plan = api.commitPending(store, { dryRun: true })
  assert.deepEqual(plan[0].rows, [
    { verb: "set", collection: "tasks", id: "call-sam", repoRel: "data/tasks/call-sam.task.md" },
    { verb: "add", collection: "tasks", id: "new-one", repoRel: "data/tasks/new-one.task.md" },
  ])
  assert.equal(plan[0].sha, null)
  assert.throws(() => api.commitPending(store, { only: ["tasks/nobody"] }), /no such record/)
  const done = api.commitPending(store, { only: ["tasks/new-one"] })
  assert.equal(done[0].subject, "dreamteamer: tasks add new-one")
  assert.match(g("status", "--porcelain"), /M data\/tasks\/call-sam\.task\.md\n\?\? stray\.txt/)
})

test("the names extensions call answer in the released shapes", () => {
  const root = seeded()
  assert.deepEqual(api.parseArgs(["sync", "--drive", "a", "--force", "--x=1", "--x=2"]), {
    flags: { drive: "a", force: true, x: ["1", "2"] },
    pos: ["sync"],
  })
  const store = new api.Store({ root })
  assert.deepEqual(api.splitRef(store.descriptors, "tasks/a/b"), { collection: "tasks", id: "a/b" })
  assert.equal(api.splitRef(store.descriptors, "nope/a"), null)
  assert.deepEqual(store.findInboundRefs("users", "dana-oren"), ["data/tasks/brief-dana.task.md"])
  assert.ok(readFileSync(api.engineBin, "utf8").includes("main"))
  const lines: string[] = []
  const log = console.log
  console.log = (s: string) => lines.push(s)
  try {
    assert.equal(api.check({ root }), 0)
    writeFileSync(join(root, "data/tasks/call-sam.task.md"), "---\nname: Call Sam\nestimate: 0\n---\n")
    assert.equal(api.check({ root }), 1)
  } finally {
    console.log = log
  }
  assert.deepEqual(lines.slice(-3), [
    "✖ tasks/call-sam",
    "    estimate: less than the minimum 1",
    "1 violation. files were NOT modified.",
  ])
  assert.equal(api.compile({ root: seeded() }), 0)
})
