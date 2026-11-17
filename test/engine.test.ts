import { test } from "node:test"
import assert from "node:assert/strict"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { parse } from "yaml"
import { DtError } from "../src/lib/DtError.ts"
import { add } from "../src/store/add.ts"
import { buildModel } from "../src/model/buildModel.ts"
import { check } from "../src/store/check.ts"
import { compile } from "../src/compile/compile.ts"
import { findCollection } from "../src/model/findCollection.ts"
import { get } from "../src/store/get.ts"
import { list } from "../src/store/list.ts"
import { listIds } from "../src/store/listIds.ts"
import { referrers } from "../src/store/referrers.ts"
import { rm } from "../src/store/rm.ts"
import { set } from "../src/store/set.ts"
import { rebuild } from "../src/store/rebuild.ts"
import { put, workspace } from "./helpers.ts"

const errors = (m: ReturnType<typeof buildModel>) => check(m).issues.filter((i) => i.severity === "error")
const refuses = (fn: () => unknown, re: RegExp) =>
  assert.throws(
    fn,
    (e: Error) => e instanceof DtError && re.test([e.message, ...e.issues.map((i) => i.message)].join("\n")),
  )

test("finds npm and workspace modules and resolves mixins, overlays and declared peers", () => {
  const m = buildModel(workspace())
  assert.deepEqual(
    m.modules.map((x) => `${x.name}:${x.origin}`),
    ["dreamteamer:engine", "people:npm", "local:workspace"],
  )
  assert.deepEqual([m.modules[1].unsupported, m.modules[1].extension], [[], "./x.mjs"])
  assert.deepEqual(Object.keys(m.collections.users.fields).sort(), ["joined", "kind", "name", "notes", "site", "tasks"])
  assert.deepEqual(
    m.collections.tasks.fields.about.type,
    ["users", "ghosts"],
    "a declared peer keeps its place in a union",
  )
  assert.equal(m.collections.tasks.fields.ghost.type, "ghosts", "and keeps its field")
  assert.deepEqual(m.issues, [])
})

test("the system collections come with the engine, and a reference to a module's source resolves from the model", () => {
  const root = workspace()
  const p = (path: string, text: string) => put(root, `modules/local/${path}`, text)
  p("agents/reviewer.agent.md", "---\nname: reviewer\ndescription: dispatch to review.\n---\nReview it.\n")
  p("commands/lab/run.command.md", "---\ndescription: run it\n---\nRun.\n")
  p("command-bindings/run--tasks.command-binding.yaml", "command: commands/lab/run\ncollection: collections/tasks\n")
  p("ui-views/tasks-mine.ui-view.yaml", "route: /tasks/mine\nscope: collection\ncollection: collections/tasks\n")
  p("skills/triage/SKILL.md", "---\nname: triage\ndescription: use when sorting.\n---\nSort.\n")
  p(
    "collections/links.collection.yaml",
    "name: links\nfields:\n  name: {type: string, required: true}\n  repo: {type: repos}\n  reads: {type: collections, many: true}\n  skill: {type: skills}\n  module: {type: modules}\n  mixin: {type: mixins}\n  agent: {type: agents}\n  command: {type: commands}\n  binding: {type: command-bindings}\n  view: {type: ui-views}\n",
  )
  const m = buildModel(root)
  assert.deepEqual(m.issues, [])
  for (const t of ["repos", "agents", "collections", "modules", "skills", "mixins", "commands", "ui-views"])
    assert.equal(m.collections[t].module, "dreamteamer", t)
  add(m, "repos", { name: "portal", url: "https://git.example/northwind/portal" })
  const links = {
    name: "Everything",
    repo: "repos/portal",
    reads: ["collections/tasks", "collections/repos"],
    skill: "skills/triage",
    module: "modules/people",
    mixin: "mixins/entity",
    agent: "agents/reviewer",
    command: "commands/lab/run",
    binding: "command-bindings/run--tasks",
    view: "ui-views/tasks-mine",
  }
  assert.equal(add(m, "links", links).id, "everything")
  refuses(() => add(m, "links", { name: "Wrong", reads: ["collections/nope"] }), /broken reference collections\/nope/)
  refuses(() => add(m, "links", { name: "Wrong", skill: "skills/nope" }), /broken reference skills\/nope/)
  assert.deepEqual(listIds(m, "skills"), ["triage", "using-dreamteamer"])
  assert.deepEqual(listIds(m, "commands"), ["lab/run"])
  assert.deepEqual(listIds(m, "modules"), ["dreamteamer", "local", "people"])
  assert.deepEqual(listIds(m, "mixins"), ["docs", "entity"])
  assert.equal(get(m, "agents/reviewer").data.instructions, "Review it.\n")
  assert.equal(get(m, "collections/links").data.name, "links")
  assert.deepEqual(get(m, "collections/tasks").data.storage, { path: "data/tasks", format: "md", suffix: "task" })
  assert.deepEqual(get(m, "modules/local").data.collections, [
    "collections/companies",
    "collections/links",
    "collections/meetings",
    "collections/memos",
    "collections/pages",
    "collections/places",
    "collections/stories",
    "collections/tasks",
    "collections/users",
  ])
  assert.deepEqual(
    list(m, "ui-views", { scope: "collection" }).map((t) => t.id),
    ["tasks-mine"],
  )
  refuses(() => add(m, "skills", { name: "x", description: "y" }), /skills are read-only here/)
  refuses(() => set(m, "collections/tasks", { description: "x" }), /collections are read-only here/)
  refuses(() => rm(m, "agents/reviewer"), /agents are read-only here/)
  refuses(() => get(m, "skills/nope"), /skills\/nope: no such record/)
  const { records, issues } = check(m)
  assert.deepEqual(issues, [])
  assert.equal(records, 2, "a source is not counted as a record")
})

test("a collection keeps how surfaces draw it, as written, with its mixins' display beneath its own", () => {
  const root = workspace()
  put(
    root,
    "modules/local/mixins/dated.mixin.yaml",
    "name: dated\nfields:\n  on: {type: date}\ndisplay:\n  list: {columns: [name, on], sort: on}\n  nav: {icon: event}\nconstraints:\n  - {required: [on]}\n",
  )
  put(
    root,
    "modules/local/collections/events.collection.yaml",
    "name: events\ntitle: Happenings\nrecord_title: '{{ name }} on {{ on }}'\ninternal: true\nsensitive: false\nmixins: [dated]\nfields:\n  name: {type: string, required: true, title: What, display: {width: 20}}\ndisplay:\n  list: {layout: board, sort: name}\n  record: {badge: on}\nconstraints:\n  - {anyOf: [{required: [name]}]}\n",
  )
  const m = buildModel(root)
  assert.deepEqual(m.issues, [])
  const c = m.collections.events
  assert.equal(c.title, "Happenings")
  assert.equal(c.record_title, "{{ name }} on {{ on }}")
  assert.equal(c.internal, true)
  assert.equal(c.sensitive, false)
  assert.deepEqual(c.display, {
    list: { columns: ["name", "on"], sort: "name", layout: "board" },
    record: { badge: "on" },
    nav: { icon: "event" },
  })
  assert.deepEqual(c.constraints, [{ anyOf: [{ required: ["name"] }] }, { required: ["on"] }])
  assert.deepEqual(c.fields.name.display, { width: 20 })
  assert.equal(m.collections.tasks.display, undefined)
  compile(m)
  const json = JSON.parse(readFileSync(join(root, ".dt/model.json"), "utf8"))
  assert.deepEqual(json.collections.events.display, c.display)
  assert.equal(json.collections.events.record_title, c.record_title)
  assert.equal(json.collections.repos.display.nav.icon, "source", "the system collections' display too")
  put(
    root,
    "modules/local/collections/events-overlay.collection.yaml",
    "name: events\noverlay: true\ntitle: Events\ndisplay:\n  nav: {order: 5}\n  list: {layout: table}\nconstraints:\n  - {required: [name]}\n",
  )
  const o = buildModel(root).collections.events
  assert.equal(o.title, "Events", "an overlay's label replaces the base's")
  assert.deepEqual(o.display, {
    list: { columns: ["name", "on"], sort: "name", layout: "table" },
    record: { badge: "on" },
    nav: { icon: "event", order: 5 },
  })
  assert.equal(o.constraints?.length, 3)
})

test("an enum written as a map takes its keys as the values and keeps how each is shown", () => {
  const root = workspace()
  put(
    root,
    "modules/local/collections/gadgets.collection.yaml",
    "name: gadgets\nfields:\n  name: {type: string, required: true}\n  level:\n    type: string\n    default: normal\n    enum:\n      low: {label: Low, color: grey}\n      normal: {label: Normal}\n      high:\n",
  )
  const m = buildModel(root)
  assert.deepEqual(m.issues, [])
  const f = m.collections.gadgets.fields.level
  assert.deepEqual(f.enum, ["low", "normal", "high"])
  assert.deepEqual(f.choices, { low: { label: "Low", color: "grey" }, normal: { label: "Normal" }, high: null })
  assert.equal(add(m, "gadgets", { name: "Lamp" }).data.level, "normal")
  assert.equal(add(m, "gadgets", { name: "Fan", level: "high" }).data.level, "high")
  refuses(() => add(m, "gadgets", { name: "Kettle", level: "extreme" }), /not one of low \| normal \| high/)
  put(
    root,
    "modules/local/collections/gadgets.collection.yaml",
    "name: gadgets\nfields:\n  level: {type: string, enum: low}\n",
  )
  assert.match(
    buildModel(root)
      .issues.map((t) => t.message)
      .join("\n"),
    /expected a list or a map of values, found text/,
  )
})

test("a typo in a descriptor is an error that stops writes and compile", () => {
  const root = workspace()
  put(
    root,
    "modules/local/collections/gadgets.collection.yaml",
    "name: gadgets\ncolour: red\nstorage: {format: toml}\nfields:\n  name: {type: string}\n  size: {type: strng}\n  rank: {type: position}\n  loose: {}\n",
  )
  const m = buildModel(root)
  const text = m.issues.map((i) => `${i.severity} ${i.where}: ${i.message}`).join("\n")
  assert.match(text, /error gadgets\.size: unknown type "strng"/)
  assert.match(text, /error gadgets: unknown storage format "toml"/)
  assert.match(text, /error gadgets\.loose: field has no type/)
  assert.match(text, /warning gadgets: unknown descriptor key\(s\) colour/)
  put(
    root,
    "modules/local/collections/logs.collection.yaml",
    "name: logs\nstorage: {path: ../elsewhere/logs}\nfields:\n  name: {type: string}\n",
  )
  assert.match(
    buildModel(root)
      .issues.map((i) => i.message)
      .join("\n"),
    /storage path, \.\.\/elsewhere\/logs, is outside the workspace/,
  )
  assert.equal(m.collections.gadgets.fields.rank.type, "position", "position is a known type")
  refuses(() => add(m, "users", { name: "Dana Oren" }), /model has errors/)
  refuses(() => compile(m), /model has errors/)
  assert.equal(existsSync(join(root, "data")), false)
})

test("a module error does not crash discovery, and a folder with no module is not a workspace", () => {
  const root = workspace()
  put(root, "modules/broken/package.json", "{ broken")
  assert.match(buildModel(root).issues[0].message, /unreadable package\.json/)
  refuses(() => buildModel(dirname(root) + "/nowhere-" + Date.now()), /not a workspace/)
  const plain = workspace()
  writeFileSync(join(plain, "package.json"), '{"name":"lib"}')
  cpSync(join(plain, "modules"), join(plain, "kept"), { recursive: true })
  for (const d of readdirSync(join(plain, "modules"))) writeFileSync(join(plain, "modules", d, "package.json"), "{}")
  refuses(() => buildModel(plain), /no dreamteamer module/)
})

test("plural names inflect as the released engine does, for the file suffix and for the command line", () => {
  const root = workspace(),
    m = buildModel(root)
  assert.equal(m.collections.companies.storage.suffix, "company")
  assert.equal(m.collections.stories.storage.suffix, "story")
  assert.equal(findCollection(m, "company")?.name, "companies")
  put(root, "data/companies/northwind.company.md", "---\nname: Northwind\n---\n")
  assert.deepEqual(listIds(m, "companies"), ["northwind"])
  assert.equal(
    get(m, "company/northwind").ref,
    "companies/northwind",
    "a command may name the collection in the singular",
  )
  assert.match(add(m, "stories", { name: "Sign in" }).path, /sign-in\.story\.md$/)
})

test("add writes the file the released engine writes: given fields, created, then defaults", () => {
  const m = buildModel(workspace())
  const u = add(m, "users", { name: "Dana Oren", notes: "Met at the fair." })
  assert.equal(u.ref, "users/dana-oren")
  const text = readFileSync(u.path, "utf8")
  assert.match(
    text,
    /^---\nname: Dana Oren\ncreated: '\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d'\nkind: person\n---\nMet at the fair\.\n$/,
  )
  const t = add(m, "tasks", { name: "Call the bank", assignee: "users/dana-oren", due: "2026-12-01", tags: "finance" })
  assert.match(t.id, /^\d{4}-\d{2}-\d{2}--call-the-bank$/)
  assert.equal(t.id.slice(0, 10), String(t.data.created).slice(0, 10), "the id takes the local day")
  assert.deepEqual(t.data.tags, ["finance"], "one value for a list field is a list of one")
  assert.match(readFileSync(t.path, "utf8"), /due: '2026-12-01'\ntags:\n  - finance\n/)
  assert.equal(set(m, t.ref, { due: "2026-12-02" }).data.due, "2026-12-02")
  assert.deepEqual(
    list(m, "tasks", { assignee: "users/dana-oren" }).map((r) => r.id),
    [t.id],
  )
  assert.deepEqual(list(m, "tasks", { status: "done" }), [])
  assert.deepEqual(errors(m), [])
  rm(m, t.ref)
  assert.deepEqual(listIds(m, "tasks"), [])
})

test("ids: date formats, basename, accents, and a hash that says it is one", () => {
  const m = buildModel(workspace())
  add(m, "companies", { name: "Northwind" })
  const starts = "2026-11-20T10:30:00+02:00"
  assert.equal(
    add(m, "meetings", { name: "Weekly sync", starts, company: "companies/northwind" }).id,
    "2026/11/2026-11-20--10-30--northwind--weekly-sync",
  )
  assert.equal(
    add(m, "meetings", { name: "Stand-up", starts }).id,
    "2026/11/2026-11-20--10-30--stand-up",
    "the next template when a field is absent",
  )
  assert.deepEqual(listIds(m, "meetings").length, 2, "nested ids are listed")
  assert.equal(add(m, "users", { name: "Zoë Brontë-Ångström" }).id, "zoe-bronte-angstrom")
  const greek = add(m, "companies", { name: "Ελένη Παπαδοπούλου" })
  assert.equal(greek.id, "x0n36jsv", "the released engine's hash for the same name")
  assert.match(greek.warnings![0], /the id is a hash/)
  refuses(() => add(m, "tasks", { due: "2026-12-01" }), /cannot make an id — give name/)
})

test("invalid writes are rejected before disk", () => {
  const m = buildModel(workspace())
  const bad: [Record<string, unknown>, RegExp][] = [
    [{}, /name: required/],
    [{ name: "x", nope: 1 }, /nope: unknown field/],
    [{ name: "x", due: "tomorrow" }, /real date/],
    [{ name: "x", due: "2026-13-45" }, /real date/],
    [{ name: "x", at: "March 5" }, /date and time with a zone/],
    [{ name: "x", assignee: "users/nobody" }, /broken reference/],
    [{ name: "x", assignee: "dana" }, /users\/<id> reference/],
    [{ name: "x", estimate: 0 }, /minimum 1/],
    [{ name: "x", estimate: 1.5 }, /integer/],
    [{ name: "x", urgent: "maybe" }, /true or false/],
    [{ name: "x", status: "later" }, /not one of todo \| done/],
    [{ name: "x", created: "last week" }, /created/],
    [{ name: "x", updated: "2026-11-01" }, /updated: unknown field/],
  ]
  for (const [input, why] of bad) refuses(() => add(m, "tasks", input, "2026-01-01--fixed"), why)
  refuses(() => add(m, "users", { name: "Bot", kind: "robot" }), /not one of/)
  refuses(() => add(m, "users", { name: "Web", site: "not a url" }), /URL/)
  assert.equal(existsSync(join(m.root, "data")), false)
})

test("check is as lenient as the released engine about how a value is written", () => {
  const root = workspace(),
    m = buildModel(root)
  add(m, "users", { name: "Dana Oren" })
  put(
    root,
    "data/tasks/2026-01-01--hand.task.md",
    "---\nname: 2026\nestimate: '3'\nurgent: 'true'\nassignee: [users/dana-oren]\n---\n",
  )
  assert.deepEqual(
    errors(m).map((t) => t.message),
    ["tasks: stale — run: relations rebuild users"],
    "only the reverse field, which a hand edit does not keep",
  )
  assert.deepEqual(rebuild(m, "users"), ["users/dana-oren"])
  assert.deepEqual(errors(m), [])
})

test("a reverse field follows its owner on add, set and rm, and is never set by hand", () => {
  const root = workspace(),
    m = buildModel(root)
  add(m, "users", { name: "Dana Oren" })
  add(m, "users", { name: "Sam Diaz" })
  const a = add(m, "tasks", { name: "Buy milk", assignee: "users/dana-oren", created: "2026-01-02T10:00:00+02:00" })
  const b = add(m, "tasks", { name: "Bake bread", assignee: "users/dana-oren", created: "2026-01-01T10:00:00+02:00" })
  assert.deepEqual(get(m, "users/dana-oren").data.tasks, [b.ref, a.ref], "sorted")
  set(m, a.ref, { assignee: "users/sam-diaz" })
  assert.deepEqual(get(m, "users/dana-oren").data.tasks, [b.ref])
  assert.deepEqual(get(m, "users/sam-diaz").data.tasks, [a.ref])
  rm(m, b.ref)
  assert.equal(get(m, "users/dana-oren").data.tasks, undefined, "the last one takes the key with it")
  assert.doesNotMatch(readFileSync(get(m, "users/dana-oren").path, "utf8"), /tasks/)
  refuses(() => set(m, "users/sam-diaz", { tasks: [] }), /generated from tasks\.assignee/)
  refuses(() => add(m, "users", { name: "Ada", tasks: [a.ref] }), /generated from tasks\.assignee/)
  assert.deepEqual(errors(m), [])
  assert.deepEqual(rebuild(m, "users"), [], "nothing to repair")
})

test("a reference into a declared peer that is not installed is unresolved, not wrong", () => {
  const root = workspace(),
    m = buildModel(root)
  put(
    root,
    "data/tasks/2026-01-01--haunted.task.md",
    "---\nname: Haunted\nghost: ghosts/casper\nabout: ghosts/casper\n---\n",
  )
  const { issues } = check(m)
  assert.deepEqual(
    issues.map((i) => `${i.severity} ${i.where}`),
    ["warning ghosts"],
  )
  assert.match(issues[0].message, /2 reference\(s\)/)
  assert.equal(
    set(m, "tasks/2026-01-01--haunted", { status: "done" }).data.status,
    "done",
    "and the record stays editable",
  )
  refuses(() => set(m, "tasks/2026-01-01--haunted", { ghost: "users/casper" }), /ghosts\/<id> reference/)
})

test("a reference or an id cannot reach outside the record it names", () => {
  const root = workspace(),
    m = buildModel(root)
  add(m, "users", { name: "Dana Oren" })
  const victim = put(dirname(root), `victim-${Date.now()}/secret.user.md`, "---\nname: Victim\n---\n")
  const out = `../../../${dirname(victim).split("/").pop()}/secret`
  for (const id of [out, "..", ".", "", "a//b", "/abs", "a/../b", "../tasks/x"]) {
    refuses(() => get(m, `users/${id}`), /invalid id/)
    refuses(() => set(m, `users/${id}`, { kind: "agent" }), /invalid id/)
    refuses(() => rm(m, `users/${id}`), /invalid id/)
    refuses(() => rm(m, `pages/${id}`), /invalid id/)
    refuses(() => add(m, "memos", { title: "Planted" }, id), /invalid id/)
  }
  refuses(() => get(m, undefined as unknown as string), /which record/)
  assert.equal(readFileSync(victim, "utf8"), "---\nname: Victim\n---\n")
  assert.deepEqual(readdirSync(join(root, "data")), ["users"])
})

test("rm refuses to break other records, or to take them along", () => {
  const root = workspace(),
    m = buildModel(root)
  add(m, "users", { name: "Dana Oren" })
  const t = add(m, "tasks", { name: "Call the bank", assignee: "users/dana-oren" })
  assert.deepEqual(referrers(m, "users/dana-oren"), [t.ref])
  refuses(() => rm(m, "users/dana-oren"), /referenced by 1 record/)
  assert.ok(existsSync(join(root, "data/users/dana-oren.user.md")))
  add(m, "pages", { name: "Welcome", content: "Hello." })
  put(root, "data/pages/welcome/cover.txt", "cover")
  put(root, "data/pages/welcome/notes/kept.memo.md", "---\ntitle: Kept\n---\n")
  refuses(() => rm(m, "pages/welcome"), /holds 1 other record\(s\) inside its folder/)
  assert.equal(rm(m, "pages/welcome", true), "pages/welcome")
  assert.equal(existsSync(join(root, "data/pages/welcome")), false)
  assert.equal(rm(m, "users/dana-oren", true), "users/dana-oren")
  assert.match(errors(m)[0].message, /broken reference users\/dana-oren/)
})

test("set changes the lines it was asked to change and keeps the rest of the file", () => {
  const root = workspace(),
    m = buildModel(root)
  const path = put(
    root,
    "data/users/sam-diaz.user.md",
    "---\n# joined through the Northwind referral\nname: \"Sam Diaz\"   # as on the badge\nkind: agent\njoined: '2026-11-01'\n---\n\nPrefers mornings.\n",
  )
  const before = readFileSync(path, "utf8")
  set(m, "users/sam-diaz", { site: "https://northwind.example" })
  assert.equal(
    readFileSync(path, "utf8"),
    before.replace("joined: '2026-11-01'\n", "joined: '2026-11-01'\nsite: https://northwind.example\n"),
  )
  set(m, "users/sam-diaz", { site: null, kind: "" })
  assert.equal(
    readFileSync(path, "utf8"),
    before.replace("kind: agent", "kind: person"),
    "a cleared field with a default goes back to it",
  )
  set(m, "users/sam-diaz", { notes: "Prefers evenings." })
  assert.match(readFileSync(path, "utf8"), /---\nPrefers evenings\.\n$/)
  refuses(() => set(m, "users/sam-diaz", { kind: "robot" }), /not one of/)
  assert.match(
    readFileSync(path, "utf8"),
    /# joined through the Northwind referral\nname: "Sam Diaz"   # as on the badge\n/,
  )
})

test("a failed or repeated write leaves what is on disk, and old temporary files are cleared", () => {
  const root = workspace(),
    m = buildModel(root)
  const u = add(m, "users", { name: "Dana" })
  const before = readFileSync(u.path, "utf8")
  refuses(() => set(m, u.ref, { kind: "robot" }), /not one of/)
  refuses(() => add(m, "users", { name: "Dana" }), /already exists/)
  assert.equal(readFileSync(u.path, "utf8"), before)
  const stale = `${u.path}.99999.tmp`,
    old = new Date(Date.now() - 3_600_000)
  writeFileSync(stale, "half")
  utimesSync(stale, old, old)
  assert.match(check(m).issues[0].message, /unrecognized file/)
  set(m, u.ref, { kind: "agent" })
  assert.deepEqual(readdirSync(dirname(u.path)), ["dana.user.md"])
})

test("check reports files no collection recognises, and JSON and folder records round-trip", () => {
  const root = workspace(),
    m = buildModel(root)
  put(root, "data/users/ana.person.md", "---\nname: Ana\nkind: nonsense\n---\n")
  mkdirSync(join(root, "data/users/dir.user.md"))
  assert.match(
    check(m)
      .issues.map((i) => `${i.severity} ${i.where}`)
      .join(),
    /warning data\/users\/ana\.person\.md/,
  )
  assert.deepEqual(listIds(m, "users"), [])
  const place = add(m, "places", { name: "Harbor Cafe", city: "Lisbon" })
  assert.equal(JSON.parse(readFileSync(place.path, "utf8")).city, "Lisbon")
  assert.equal(set(m, place.ref, { city: "Porto" }).data.city, "Porto")
  const page = add(m, "pages", { name: "Welcome", content: "Hello." })
  assert.match(page.path, /data\/pages\/welcome\/index\.md$/)
  assert.deepEqual(listIds(m, "pages"), ["welcome"])
})

test("compile writes only under .dt and .dreamteamer, is the same wherever the workspace sits, and says enough to write a record", () => {
  const root = workspace(),
    m = buildModel(root)
  const files = compile(m)
  assert.ok(files.every((f) => f.startsWith(join(root, ".dt/")) || f.startsWith(join(root, ".dreamteamer"))))
  assert.deepEqual(readdirSync(root).sort(), [".dreamteamer", ".dt", "modules", "node_modules", "package.json"])
  const model = readFileSync(join(root, ".dt/model.json"), "utf8"),
    agents = readFileSync(join(root, ".dt/AGENTS.md"), "utf8")
  assert.equal(model.includes(root), false, "no absolute path of the workspace")
  const moved = root + "-moved"
  cpSync(root, moved, { recursive: true })
  compile(buildModel(moved))
  assert.equal(readFileSync(join(moved, ".dt/model.json"), "utf8"), model)
  assert.match(agents, /node .*bin\/dt\.ts <verb>/)
  assert.match(
    agents,
    /\*\*tasks\*\* \(local\)[\s\S]*records: data\/tasks\/<id>\.task\.md · id from `\{\{ created \| date \}\}--\{\{ name \| slug \}\}`/,
  )
  assert.match(
    agents,
    /fields: name\*: string · assignee: → users · about: → users\|ghosts .* tags\[\]: string .* status: todo\|done \(default todo\) · notes: the text below the frontmatter/,
  )
})

test("compile also writes the released engine's compiled layout, with the keys its readers use", () => {
  const root = workspace()
  const p = (path: string, text: string) => put(root, `modules/local/${path}`, text)
  const cmd = p("commands/lab/run.command.md", "---\ndescription: run it\n---\nRun.\n")
  p("skills/triage/SKILL.md", "---\nname: triage\ndescription: use when sorting.\n---\nSort.\n")
  p("skills/triage/bin/sort.py", "print('sorted')\n")
  p("ui-views/tasks-mine.ui-view.yaml", "route: /tasks/mine\nscope: collection\ncollection: collections/tasks\n")
  put(root, ".dreamteamer/editor.json", "{}\n")
  put(root, ".dreamteamer/commands/gone.command.md", "---\n---\n")
  compile(buildModel(root))
  const rt = (path: string) => readFileSync(join(root, ".dreamteamer", path), "utf8")
  const tasks = parse(rt("collections/tasks.collection.yaml"))
  assert.equal(tasks.name, "tasks")
  assert.equal(tasks.storage.path, "data/tasks")
  assert.match(
    rt("collections/tasks.collection.yaml"),
    /^storage:\n {2}path: data\/tasks\n/m,
    "storage as a block, as module scripts match it",
  )
  assert.deepEqual(Object.keys(tasks.compiled.fields).slice(0, 4), ["id", "created", "last_modified", "name"])
  assert.equal(tasks.compiled.fields.assignee.on_delete, "restrict")
  assert.equal(tasks.compiled.fields.due.title, "Due")
  assert.deepEqual(
    [
      tasks.compiled.module,
      tasks.compiled.runtime,
      tasks.compiled.defaults.title,
      tasks.compiled.defaults.record_title,
    ],
    ["local", false, "Tasks", "{{ name }}"],
  )
  assert.deepEqual(parse(rt("collections/users.collection.yaml")).compiled.overlaid_by, ["local"])
  assert.equal(parse(rt("collections/skills.collection.yaml")).compiled.runtime, true)
  assert.equal(rt("commands/lab/run.command.md"), readFileSync(cmd, "utf8"), "a source file is copied as it is")
  assert.equal(rt("skills/triage/bin/sort.py"), "print('sorted')\n", "and a skill's whole folder")
  assert.ok(existsSync(join(root, ".dreamteamer/skills/using-dreamteamer/references/records.md")))
  assert.equal(parse(rt("ui-views/tasks-mine.ui-view.yaml")).route, "/tasks/mine")
  const local = parse(rt("modules/local.module.yaml"))
  assert.deepEqual(
    [local.location, local.path, local.collections.includes("collections/tasks")],
    ["modules", "modules/local", true],
  )
  assert.equal(existsSync(join(root, ".dreamteamer/commands/gone.command.md")), false, "a kind folder is replaced")
  assert.equal(rt("editor.json"), "{}\n", "what is not a kind folder is left alone")
  const manifest = parse(rt("manifest.yaml"))
  assert.equal(typeof manifest.compiled, "string")
  assert.deepEqual(manifest.namespaces, [])
  assert.deepEqual(manifest.layers, [])
  assert.equal(manifest.data_path, "data")
  assert.deepEqual(manifest.modules[2], {
    name: "local",
    location: "modules",
    channel: "inline",
    root: "modules/local",
  })
  assert.deepEqual(manifest.entries["commands/lab/run.command.md"], {
    sources: [{ path: "modules/local/commands/lab/run.command.md" }],
  })
  assert.match(
    rt("manifest.yaml"),
    /^compiled: '\d{4}-/m,
    "a timestamp is quoted, so a YAML 1.1 reader keeps it a string",
  )
})

test("a folder record is not removed while other records live inside it, whatever their collection", () => {
  const root = workspace(),
    m = buildModel(root)
  add(m, "pages", { name: "Welcome", content: "hi" })
  add(m, "pages", { name: "Sub", content: "sub" }, "welcome/sub")
  refuses(() => rm(m, "pages/welcome"), /holds 1 other record/)
  assert.deepEqual(listIds(m, "pages"), ["welcome", "welcome/sub"])
})

test("set keeps comments wherever they sit, and never writes text that reads back as something else", () => {
  const root = workspace(),
    m = buildModel(root)
  const file = (name: string, text: string) => put(root, `data/users/${name}.user.md`, text)
  const lead = file(
    "lead",
    "---\n# Referred by Northwind\nname: Sam\n# the kind below is temporary\nkind: agent\n# archived\n---\nBody.\n",
  )
  set(m, "users/lead", { name: "Samuel", kind: "person", site: "https://northwind.example" })
  assert.equal(
    readFileSync(lead, "utf8"),
    "---\n# Referred by Northwind\nname: Samuel\n# the kind below is temporary\nkind: person\nsite: https://northwind.example\n# archived\n---\nBody.\n",
  )
  const anchor = file("anchor", "---\nkind: &k agent\nname: *k\n---\n")
  set(m, "users/anchor", { kind: "person" })
  assert.deepEqual(
    [get(m, "users/anchor").data.kind, get(m, "users/anchor").data.name],
    ["person", "agent"],
    "an alias is resolved, not left dangling",
  )
  const empty = file("empty", "---\n---\nHello\n")
  set(m, "users/empty", { name: "Hi" })
  assert.equal(readFileSync(empty, "utf8"), "---\nname: Hi\n---\nHello\n")
  const block = file(
    "block",
    "---\nname: Sam\nsite: >-\n  https://northwind.example/a/very/long/path\nkind: agent\n---\n",
  )
  set(m, "users/block", { kind: "person" })
  assert.equal(
    readFileSync(block, "utf8"),
    "---\nname: Sam\nsite: >-\n  https://northwind.example/a/very/long/path\nkind: person\n---\n",
  )
  assert.deepEqual(errors(m), [])
})

test("a link, a different case or a binary collection gives no way out of the record that was named", () => {
  const root = workspace(),
    m = buildModel(root)
  const outside = dirname(put(dirname(root), `outside-${Date.now()}/sub/index.md`, "---\nname: Outside\n---\n"))
  add(m, "memos", { title: "Keep" }, "m1")
  add(m, "pages", { name: "Welcome" })
  symlinkSync(dirname(outside), join(root, "data/memos/link"))
  symlinkSync(dirname(outside), join(root, "data/pages/link"))
  refuses(() => add(m, "memos", { title: "Planted" }, "link/planted"), /symbolic link leads out/)
  refuses(() => rm(m, "pages/link/sub"), /symbolic link leads out|no such record/)
  assert.ok(existsSync(join(outside, "index.md")))
  assert.deepEqual(listIds(m, "memos"), ["m1"], "a link inside a collection folder is not a record")
  add(m, "tasks", { name: "Uses memo", about: undefined, assignee: undefined })
  refuses(() => rm(m, "memos/M1"), /no such record/)
  refuses(() => get(m, "memos/M1"), /no such record/)
  put(
    root,
    "modules/local/collections/logos.collection.yaml",
    "name: logos\ndescription: logos.\nstorage: {format: binary}\nfields: {}\n",
  )
  put(
    root,
    "modules/local/collections/brands.collection.yaml",
    "name: brands\ndescription: brands.\nfields:\n  name: {type: string, required: true}\n  logo: {type: logos}\n",
  )
  put(root, "data/logos/northwind.logo.svg", "<svg/>")
  const m2 = buildModel(root)
  assert.equal(add(m2, "brands", { name: "Northwind", logo: "logos/northwind" }).data.logo, "logos/northwind")
  refuses(() => add(m2, "brands", { name: "Eastwind", logo: "logos/../../../../etc/hosts" }), /broken reference/)
})

test("a collection named like another one's singular keeps its own records", () => {
  const root = workspace()
  put(
    root,
    "modules/local/collections/processes.collection.yaml",
    "name: processes\ndescription: processes.\nfields:\n  name: {type: string, required: true}\n",
  )
  put(
    root,
    "modules/local/collections/process.collection.yaml",
    "name: process\ndescription: process.\nfields:\n  name: {type: string, required: true}\n",
  )
  const m = buildModel(root)
  assert.equal(add(m, "process", { name: "Alpha" }).ref, "process/alpha")
  assert.equal(add(m, "processes", { name: "Alpha" }).ref, "processes/alpha")
  assert.equal(rm(m, "process/alpha"), "process/alpha")
  assert.deepEqual(listIds(m, "processes"), ["alpha"])
})

test("check does not mistake one collection's records for stray files of another", () => {
  const root = workspace()
  put(
    root,
    "modules/local/collections/drafts.collection.yaml",
    "name: drafts\ndescription: drafts.\nstorage: {path: data/memos}\nfields:\n  title: {type: string, required: true}\n",
  )
  const m = buildModel(root)
  add(m, "memos", { title: "A memo" }, "m1")
  add(m, "drafts", { title: "A draft" }, "d1")
  put(root, "data/memos/.obsidian/workspace.json", "{}")
  put(root, "data/memos/readme.txt", "stray")
  assert.deepEqual(
    check(m).issues.map((i) => i.where),
    ["data/memos/readme.txt"],
  )
  assert.deepEqual(list(m, "memos", { title: "undefined" }), [])
})

/** a collection whose fields hold objects, lists of objects and maps, beside the invented workspace */
function shops() {
  const root = workspace()
  put(
    root,
    "modules/local/collections/shops.collection.yaml",
    [
      "name: shops",
      "description: shops.",
      "fields:",
      "  name: {type: string, required: true}",
      "  address:",
      "    type: object",
      "    fields:",
      "      city: {type: string, required: true}",
      "      zip: {type: string, pattern: '^\\d{5}$'}",
      "      country: {type: string, required: true, default: nl}",
      "      size: {type: string, enum: [small, large]}",
      "      manager: {type: users}",
      "  staff:",
      "    type: object",
      "    many: true",
      "    fields:",
      "      person: {type: users, required: true}",
      "      shifts: {type: integer, many: true, minimum: 0}",
      "  hours: {type: map, values: integer}",
      "  links: {type: map, values: users}",
      "  extra: {type: map}",
      "",
    ].join("\n"),
  )
  return root
}

test("an object's fields and a map's values are checked on write, as the released engine's schema checks them", () => {
  const root = shops()
  const m = buildModel(root)
  assert.deepEqual(m.issues, [])
  add(m, "users", { name: "Dana Oren" })
  const bad = {
    name: "Corner shop",
    address: { zip: "abc", size: "huge", manager: "users/nobody", planet: "Mars" },
    staff: [{ person: "users/dana-oren", shifts: [1, -1] }, { shifts: "x" }],
    hours: { mon: "early", tue: 9 },
  }
  assert.throws(
    () => add(m, "shops", bad),
    (e: Error) =>
      e instanceof DtError &&
      assert.deepEqual(
        e.issues.map((t) => t.message),
        [
          "address.city: required",
          "address.zip: does not match ^\\d{5}$",
          "address.size: not one of small | large",
          "address.manager: broken reference users/nobody",
          "staff[0].shifts: less than the minimum 0",
          "staff[1].person: required",
          "staff[1].shifts: expected an integer",
          "hours.mon: expected an integer",
        ],
      ) === undefined,
  )
  const good = {
    name: "Corner shop",
    address: { city: "Utrecht", zip: "12345", manager: "users/dana-oren", planet: "Mars" },
    staff: [{ person: "users/dana-oren", shifts: [1, "2"] }],
    hours: { mon: 9, tue: "10" },
    links: { site: "not a reference at all" },
    extra: { anything: [1, { deep: true }] },
  }
  assert.equal(add(m, "shops", good).id, "corner-shop", "an undeclared key and a map of references are let through")
  const one = add(m, "shops", { name: "One", staff: { person: "users/dana-oren" } })
  assert.deepEqual(one.data.staff, [{ person: "users/dana-oren" }], "add takes one value for a list of one, as always")
  refuses(() => add(m, "shops", { name: "Two", address: [{ city: "Utrecht" }] }), /address: expected a map/)
  refuses(() => add(m, "shops", { name: "Three", hours: "9 to 5" }), /hours: expected a map/)
  refuses(() => rm(m, "users/dana-oren"), /referenced by 2 record\(s\)[\s\S]*shops\/corner-shop/)
  rm(m, "shops/one")
  put(root, "data/shops/hand.shop.md", "---\nname: Hand\naddress: {zip: '1'}\nstaff: [{person: users/ghost}]\n---\n")
  put(root, "data/shops/single.shop.md", "---\nname: Single\nstaff: {person: users/dana-oren}\n---\n")
  assert.deepEqual(
    errors(m).map((t) => `${t.where} ${t.message}`),
    [
      "shops/hand address.city: required",
      "shops/hand address.zip: does not match ^\\d{5}$",
      "shops/hand staff[0].person: broken reference users/ghost",
      "shops/single staff: expected a list of maps",
    ],
  )
})

test("a field nested in an object or a map is read as a field, and a type there must exist", () => {
  const root = shops()
  put(
    root,
    "modules/local/collections/kiosks.collection.yaml",
    "name: kiosks\ndescription: kiosks.\nfields:\n  name: {type: string}\n  spot: {type: object, fields: {lat: {type: numbr}, lon: {}}}\n  tally: {type: map, values: {type: stores}}\n",
  )
  const text = buildModel(root)
    .issues.map((i) => `${i.where}: ${i.message}`)
    .join("\n")
  assert.match(text, /kiosks\.spot: fields\.lon: field has no type/)
  put(
    root,
    "modules/local/collections/kiosks.collection.yaml",
    "name: kiosks\ndescription: kiosks.\nfields:\n  name: {type: string}\n  spot: {type: object, fields: {lat: {type: numbr}}}\n  tally: {type: map, values: {type: stores}}\n",
  )
  const again = buildModel(root)
    .issues.map((i) => `${i.where}: ${i.message}`)
    .join("\n")
  assert.match(again, /kiosks\.spot: unknown type "numbr"/)
  assert.match(again, /kiosks\.tally: unknown type "stores"/)
  const m = buildModel(shops())
  assert.deepEqual(m.collections.shops.fields.hours.values, { type: "integer" })
  assert.equal(m.collections.shops.fields.address.fields?.zip.pattern, "^\\d{5}$")
})

test("a unique value is refused on write when another record holds it, and check names the second holder", () => {
  const root = workspace()
  put(
    root,
    "modules/local/collections/badges.collection.yaml",
    "name: badges\ndescription: badges.\nfields:\n  name: {type: string, required: true}\n  code: {type: string, unique: true}\n  holder: {type: users, unique: true}\n  tags: {type: string, many: true, unique: true}\n",
  )
  const m = buildModel(root)
  add(m, "users", { name: "Dana Oren" })
  add(m, "badges", { name: "Gold", code: "A1", holder: "users/dana-oren", tags: ["x"] })
  refuses(
    () => add(m, "badges", { name: "Silver", code: "A1" }),
    /code: "A1" is already taken by badges\/gold \(unique\)/,
  )
  refuses(
    () => add(m, "badges", { name: "Bronze", holder: "users/dana-oren" }),
    /holder: "users\/dana-oren" is already taken by badges\/gold/,
  )
  add(m, "badges", { name: "Silver", code: "B2", tags: ["x"] })
  add(m, "badges", { name: "Tin", code: "" })
  add(m, "badges", { name: "Lead" })
  refuses(() => set(m, "badges/silver", { code: "A1" }), /code: "A1" is already taken by badges\/gold/)
  set(m, "badges/gold", { code: "A1", name: "Gold!" })
  assert.deepEqual(errors(m), [])
  put(root, "data/badges/copper.badge.md", "---\nname: Copper\ncode: A1\n---\n")
  put(root, "data/badges/zinc.badge.md", "---\nname: Zinc\ncode: A1\n---\n")
  set(m, "badges/silver", { name: "Silver!" })
  assert.deepEqual(
    errors(m).map((t) => `${t.where} ${t.message}`),
    [
      'badges/gold code: "A1" is already taken by badges/copper (unique)',
      'badges/zinc code: "A1" is already taken by badges/copper (unique)',
    ],
  )
})

test("a collection's constraints are enforced on write and by check, with the verdicts the released engine gives", () => {
  const root = workspace()
  const c = (name: string, text: string) =>
    put(root, `modules/local/collections/${name}.collection.yaml`, `name: ${name}\ndescription: ${name}.\n${text}`)
  // the shapes the published modules write: an engagement's stage and outcome, a decision's reviewable fields, a
  // workflow's steps — and the keywords around them that the rules of other modules use
  c(
    "deals",
    "fields:\n  name: {type: string, required: true}\n  stage: {type: string, enum: [lead, closed], default: lead}\n  outcome: {type: string, enum: [won, lost]}\nconstraints:\n  - if: {properties: {outcome: {type: string}}, required: [outcome]}\n    then: {properties: {stage: {const: closed}}}\n  - if: {properties: {stage: {const: closed}}, required: [stage]}\n    then: {required: [outcome]}\n",
  )
  c(
    "flows",
    "fields:\n  name: {type: string, required: true}\n  steps: {type: object, many: true, fields: {command: {type: string}, stop: {type: string}}}\n  kind: {type: string}\n  level: {type: integer}\n  tags: {type: string, many: true}\nconstraints:\n  - properties: {steps: {items: {if: {not: {required: [command]}}, then: {required: [stop]}}}}\n  - anyOf: [{required: [kind]}, {required: [tags], properties: {tags: {minItems: 2}}}]\n  - if: {properties: {level: {type: integer, minimum: 3}}, required: [level]}\n    then: {properties: {kind: {enum: [deep, abyss], minLength: 5}}, required: [kind]}\n",
  )
  const m = buildModel(root)
  assert.deepEqual(m.issues, [])
  add(m, "deals", { name: "Open" })
  add(m, "deals", { name: "Won", stage: "closed", outcome: "won" })
  refuses(() => add(m, "deals", { name: "Early", outcome: "won" }), /stage: must be "closed" — constraint 1 of deals/)
  refuses(() => set(m, "deals/open", { stage: "closed" }), /outcome: required — constraint 2 of deals/)
  set(m, "deals/open", { stage: "closed", outcome: "lost" })
  add(m, "flows", { name: "Run", kind: "k", steps: [{ command: "x" }, { stop: "decide" }] })
  refuses(() => add(m, "flows", { name: "Stuck", kind: "k", steps: [{}] }), /steps\[0\]\.stop: required/)
  refuses(() => add(m, "flows", { name: "Bare", tags: ["a"] }), /matches none of the alternatives \(anyOf\)/)
  add(m, "flows", { name: "Tagged", tags: ["a", "b"] })
  refuses(() => add(m, "flows", { name: "Deep", level: 4, kind: "abc" }), /kind: not one of "deep" \| "abyss"/)
  add(m, "flows", { name: "Abyss", level: 4, kind: "abyss" })
  assert.deepEqual(errors(m), [])
  // as the released validator does, a rule's `type` converts the value it reads: "1" is the number 1, below 3
  put(root, "data/flows/low.flow.md", "---\nname: Low\nlevel: '1'\ntags: [a, b]\n---\n")
  put(root, "data/flows/high.flow.md", "---\nname: High\nlevel: '5'\ntags: [a, b]\n---\n")
  put(root, "data/deals/blank.deal.md", "---\nname: Blank\nstage: lead\noutcome:\n---\n")
  assert.deepEqual(
    errors(m).map((t) => `${t.where} ${t.message}`),
    [
      "deals/blank outcome: not one of won | lost",
      'deals/blank stage: must be "closed" — constraint 1 of deals',
      "flows/high kind: required — constraint 3 of flows",
    ],
  )
})

test("a constraint keyword this engine does not evaluate is an error in the model, never skipped", () => {
  const root = workspace()
  put(
    root,
    "modules/local/collections/gizmos.collection.yaml",
    "name: gizmos\ndescription: gizmos.\nfields:\n  name: {type: string}\nconstraints:\n  - {dependentRequired: {name: [size]}}\n  - if: {properties: {name: {type: text}}}\n  - {required: name}\n",
  )
  const m = buildModel(root)
  assert.deepEqual(
    m.issues.map((t) => `${t.severity} ${t.where}: ${t.message}`),
    [
      'error gizmos: constraints[0]: "dependentRequired" is a keyword this engine does not evaluate — a constraint uses if then else not allOf anyOf oneOf properties items required const enum type pattern minimum maximum minLength maxLength minItems maxItems',
      'error gizmos: constraints[1].if.properties.name.type: "text" is not a JSON Schema type — string number integer boolean null object array',
      "error gizmos: constraints[2].required: expected a list, found text",
    ],
  )
  refuses(() => add(m, "gizmos", { name: "x" }), /model has errors/)
})

test("a null is checked as the released engine's validator reads it: the empty value of its type", () => {
  const root = shops()
  const m = buildModel(root)
  add(m, "users", { name: "Dana Oren" })
  put(
    root,
    "data/tasks/2026-11-17--blank.task.md",
    "---\nname: Blank\nassignee:\ndue:\ntags:\nurgent:\nestimate:\nstatus: todo\nnotes:\n---\n",
  )
  put(
    root,
    "data/shops/blank.shop.md",
    "---\nname: Blank\naddress: {city: Utrecht, zip: null, size: null}\nhours: {mon: null}\nstaff:\n---\n",
  )
  assert.deepEqual(
    errors(m).map((t) => `${t.where} ${t.message}`),
    [
      "shops/blank address.zip: does not match ^\\d{5}$",
      "shops/blank address.size: not one of small | large",
      "shops/blank staff: expected a list of maps",
      "tasks/2026-11-17--blank assignee: expected a <collection>/<id> reference",
      "tasks/2026-11-17--blank due: expected a real date, YYYY-MM-DD",
      "tasks/2026-11-17--blank estimate: less than the minimum 1",
    ],
  )
})

test("a collection stored inside another's folder is an error in the model, and nothing is removed through it", () => {
  const root = workspace()
  const m0 = buildModel(root)
  add(m0, "users", { name: "Dana Oren" })
  add(m0, "tasks", { name: "Call", assignee: "users/dana-oren" })
  put(
    root,
    "modules/local/collections/everything.collection.yaml",
    "name: everything\ndescription: everything.\nstorage: {path: data, suffix: user}\nfields:\n  name: {type: string}\n",
  )
  put(
    root,
    "modules/local/collections/beside.collection.yaml",
    "name: beside\ndescription: beside.\nstorage: {path: data/users-archive/}\nfields:\n  name: {type: string}\n",
  )
  const m = buildModel(root)
  const text = m.issues.map((t) => `${t.severity} ${t.where}: ${t.message}`).join("\n")
  assert.match(text, /error users: its records are stored under data\/users, inside the folder of everything \(data\)/)
  assert.match(text, /error beside: .* inside the folder of everything/)
  assert.doesNotMatch(
    text,
    /inside the folder of users\b/,
    "a folder whose name begins with another's is not inside it",
  )
  assert.doesNotMatch(text, /error (skills|collections)/, "the source kinds are not data folders")
  refuses(() => rm(m, "everything/users/dana-oren"), /model has errors/)
  assert.ok(existsSync(join(root, "data/users/dana-oren.user.md")))
})

test("an overlay's own keys replace its base's, storage whole, as the released engine applies them", () => {
  const root = workspace()
  put(
    root,
    "modules/local/collections/companies-overlay.collection.yaml",
    "name: companies\noverlay: true\ndescription: An organisation.\nstorage: {shape: folder, entry: company.md}\n",
  )
  put(root, "modules/local/collections/places-overlay.collection.yaml", "name: places\noverlay: true\ntitle: Spots\n")
  const m = buildModel(root)
  assert.deepEqual(m.issues, [])
  const c = m.collections.companies
  assert.equal(c.description, "An organisation.")
  assert.deepEqual([c.storage.path, c.storage.shape, c.storage.entry], ["data/companies", "folder", "company.md"])
  assert.deepEqual([m.collections.places.title, m.collections.places.storage.format], ["Spots", "json"])
  const r = add(m, "companies", { name: "Northwind" })
  assert.equal(r.path, join(root, "data/companies/northwind/company.md"))
  assert.equal(get(buildModel(root), "companies/northwind").data.name, "Northwind")
})

test("records stored under their owner are read, written and moved where the released engine keeps them", () => {
  const root = workspace()
  put(
    root,
    "modules/local/collections/companies.collection.yaml",
    "name: companies\nstorage: {path: data/companies, shape: folder, entry: index.md}\nfields:\n  name: {type: string, required: true}\n",
  )
  put(
    root,
    "modules/local/collections/meetings.collection.yaml",
    "name: meetings\nstorage: {path: data/meetings, under: {parent: company, subfolder: meetings}}\nfields:\n  name: {type: string, required: true}\n  company: {type: companies}\n",
  )
  const m = buildModel(root)
  for (const n of ["northwind", "harbor"]) add(m, "companies", { name: n })
  // the files the released engine 0.49.1 writes for the same adds
  assert.equal(
    add(m, "meetings", { name: "Kickoff", company: "companies/northwind" }).path,
    join(root, "data/companies/northwind/meetings/kickoff.meeting.md"),
  )
  assert.equal(add(m, "meetings", { name: "Loose" }).path, join(root, "data/meetings/loose.meeting.md"))
  assert.deepEqual(listIds(m, "meetings"), ["kickoff", "loose"])
  assert.equal(
    set(m, "meetings/kickoff", { company: "companies/harbor" }).path,
    join(root, "data/companies/harbor/meetings/kickoff.meeting.md"),
  )
  assert.ok(!existsSync(join(root, "data/companies/northwind/meetings")))
  assert.deepEqual(errors(m), [])
  assert.throws(() => add(m, "meetings", { name: "Kickoff" }), /already exists/)
  assert.throws(() => rm(m, "companies/harbor"), /referenced by 1 record/)
  // a file where its owner field does not put it, and an id held twice: the released check's verdicts
  cpSync(
    join(root, "data/companies/harbor/meetings/kickoff.meeting.md"),
    join(root, "data/companies/northwind/meetings/kickoff.meeting.md"),
  )
  writeFileSync(join(root, "data/meetings/loose.meeting.md"), "---\nname: Loose\ncompany: companies/harbor\n---\n")
  assert.deepEqual(
    errors(m).map((t) => `${t.where}: ${t.message}`),
    [
      "meetings/kickoff: held twice — data/companies/harbor/meetings/kickoff.meeting.md and data/companies/northwind/meetings/kickoff.meeting.md. Remove one",
      "meetings/loose: stored in data/meetings but company is companies/harbor — move the file where its owner puts it",
    ],
  )
  put(
    root,
    "modules/local/collections/memos.collection.yaml",
    "name: memos\nstorage: {under: {parent: title, subfolder: ../x}}\nfields:\n  title: {type: string, required: true}\n",
  )
  assert.match(
    errors(buildModel(root))
      .map((t) => t.message)
      .join("\n"),
    /must be a relative folder/,
  )
})

test("record layers lend their records, and clones that are not layers are modules, as the released engine reads them", () => {
  const root = workspace()
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>
  pkg.dreamteamer = { git_modules: { archive: { records: ["users"] }, hq: {}, kit: {}, missing: {} } }
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg))
  put(root, "git_modules/archive/package.json", '{"name": "archive"}')
  put(root, "git_modules/archive/data/users/sam.user.md", "---\nname: Sam\n---\n")
  put(root, "git_modules/archive/data/tasks/unread.task.md", "---\nname: Not lent\n---\n")
  // another workspace: every collection both have, and its own reverse fields kept among its own records
  put(
    root,
    "git_modules/hq/package.json",
    '{"name": "hq", "dreamteamer": {"workspace_module": "hq", "data_path": "records"}}',
  )
  put(root, "git_modules/hq/records/users/kim.user.md", "---\nname: Kim\ntasks: [tasks/plan]\n---\n")
  put(root, "git_modules/hq/records/tasks/plan.task.md", "---\nname: Plan\nassignee: users/kim\n---\n")
  // a bundle of modules
  put(root, "git_modules/kit/package.json", '{"name": "kit", "dreamteamer": {}}')
  put(root, "git_modules/kit/modules/extra/package.json", '{"name": "extra", "dreamteamer": {}}')
  put(
    root,
    "git_modules/kit/modules/extra/collections/notes.collection.yaml",
    "name: notes\nfields:\n  title: {type: string}\n",
  )
  const m = buildModel(root)
  assert.ok(m.modules.some((t) => t.name === "extra") && m.collections.notes)
  assert.deepEqual(m.collections.users.layers, [
    { name: "archive", path: "git_modules/archive/data/users" },
    { name: "hq", path: "git_modules/hq/records/users" },
    { name: "missing", path: "git_modules/missing/data/users" },
  ])
  assert.deepEqual(
    m.collections.tasks.layers?.map((t) => t.name),
    ["hq", "missing"],
  )
  assert.deepEqual(listIds(m, "users"), ["kim", "sam"])
  assert.deepEqual(listIds(m, "tasks"), ["plan"])
  // a new record is this workspace's; an edit lands where the record is; a reverse field stays in its repository
  const t = add(m, "tasks", { name: "Brief", assignee: "users/sam" }, "brief")
  assert.equal(t.path, join(root, "data/tasks/brief.task.md"))
  assert.equal(get(m, "users/sam").data.tasks, undefined)
  assert.equal(set(m, "users/sam", { name: "Samuel" }).path, join(root, "git_modules/archive/data/users/sam.user.md"))
  assert.throws(() => add(m, "users", { name: "Sam" }), /already exists/)
  assert.deepEqual(errors(m), [])
  put(root, "git_modules/hq/records/users/sam.user.md", "---\nname: Sam again\n---\n")
  assert.deepEqual(
    errors(m).map((t) => t.message),
    [
      "held twice — git_modules/archive/data/users/sam.user.md and git_modules/hq/records/users/sam.user.md. Remove one",
    ],
  )
})
