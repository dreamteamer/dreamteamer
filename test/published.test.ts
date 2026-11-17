// The engine against real published modules, at the versions pinned in this repository's devDependencies.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { add } from "../src/store/add.ts"
import { compile } from "../src/compile/compile.ts"
import { buildModel } from "../src/model/buildModel.ts"
import { check } from "../src/store/check.ts"
import { commandsFor } from "../src/store/commandsFor.ts"
import { get } from "../src/store/get.ts"
import { listIds } from "../src/store/listIds.ts"
import { asObject } from "../src/lib/asObject.ts"
import { listFiles } from "../src/lib/listFiles.ts"
import { publishedWorkspace, put } from "./helpers.ts"

test("the system module is the released engine's own files, byte for byte, and is loaded once", () => {
  const ours = new URL("../", import.meta.url)
  const released = new URL("../node_modules/dreamteamer/", import.meta.url)
  for (const dir of ["collections", "mixins", "agents", "skills/using-dreamteamer"]) {
    const files = (base: URL) =>
      readdirSync(new URL(dir, base), { recursive: true, withFileTypes: true })
        .filter((t) => t.isFile())
        .map((t) => join(relative(fileURLToPath(new URL(dir, base)), t.parentPath), t.name))
        .sort()
    assert.deepEqual(files(ours), files(released), dir)
    for (const f of files(ours))
      assert.ok(readFileSync(new URL(`${dir}/${f}`, ours)).equals(readFileSync(new URL(`${dir}/${f}`, released))), f)
  }
  assert.deepEqual(readdirSync(new URL("skills", ours)), ["using-dreamteamer"])
  const m = buildModel(publishedWorkspace())
  assert.deepEqual(
    m.modules.filter((t) => t.name === "dreamteamer").map((t) => t.origin),
    ["engine"],
  )
  assert.equal(m.modules[0].version, JSON.parse(readFileSync(new URL("package.json", released), "utf8")).version)
})

test("the released engine reads the compiled layout written here, and presents it as its own compile would", async () => {
  const root = publishedWorkspace()
  compile(buildModel(root))
  const api = await import("../node_modules/dreamteamer/src/api.js")
  const descriptors = api.loadDescriptors(root)
  assert.ok(descriptors.has("rnd/user-stories") && descriptors.has("repos"))
  const p = api.presentation(descriptors)
  // pinned from the released engine's own compile of the same modules
  assert.deepEqual(
    p.collections.find((t: { collection: string }) => t.collection === "tasks"),
    {
      collection: "tasks",
      title: "Tasks",
      nav: { icon: "checklist" },
      list: {
        layout: "table",
        columns: ["name", "status", "assignee", "created", "due", "project", "tags"],
        sort: "-created",
      },
      record: { layout: "page" },
      form: {
        sections: [
          { title: "Provenance", fields: ["author", "creation_context", "source", "confidence"], collapsed: true },
        ],
      },
      record_title: "{{ name }}",
      record_type: "task",
      runtime: false,
      internal: false,
    },
  )
  assert.deepEqual(
    p.fields.tasks.slice(0, 3).map((t: { field: string }) => t.field),
    ["id", "created", "last_modified"],
  )
  const skills = descriptors.get("skills")
  assert.ok(skills)
  assert.equal(api.storageOf(skills).runtime, true)
})

test("the published modules resolve without an error, peers included", () => {
  const m = buildModel(publishedWorkspace())
  assert.deepEqual(
    m.issues.filter((i) => i.severity === "error"),
    [],
  )
  assert.equal(m.modules.length, 8)
  for (const name of [
    "tasks",
    "users",
    "teams",
    "companies",
    "contacts",
    "meetings",
    "rnd/user-stories",
    "rnd/releases",
  ])
    assert.ok(m.collections[name], name)
  assert.equal(m.collections.tasks.fields.project.type, "projects", "a field into a peer that is not installed is kept")
  assert.equal(m.collections.companies.storage.suffix, "company")
  assert.equal(m.collections["rnd/user-stories"].storage.suffix, "user-story")
  assert.equal(m.collections["meeting-analyses"], undefined)
})

test("records get the ids and file names the released engine gives them", () => {
  const root = publishedWorkspace(),
    m = buildModel(root)
  assert.match(add(m, "companies", { name: "Northwind" }).path, /data\/companies\/northwind\.company\.md$/)
  const meeting = add(m, "meetings", {
    name: "Weekly sync",
    starts: "2026-11-20T10:30:00+02:00",
    company: "companies/northwind",
  })
  assert.equal(meeting.id, "2026/11/2026-11-20--10-30--northwind--weekly-sync")
  add(m, "rnd/products", { name: "Northwind Portal" })
  assert.equal(
    add(m, "rnd/releases", { version: "1.2.0", product: "rnd/products/northwind-portal" }).id,
    "northwind-portal/1.2.0",
  )
  assert.equal(
    add(m, "rnd/change-requests", {
      key: "cr-lab-001",
      name: "Faster search",
      products: ["rnd/products/northwind-portal"],
    }).id,
    "cr-lab-001",
  )
  add(m, "users", { name: "Dana Oren" })
  const task = add(m, "tasks", { name: "Call the bank", assignee: "users/dana-oren", tags: "finance" })
  assert.match(
    readFileSync(task.path, "utf8"),
    /^---\nname: Call the bank\nassignee: users\/dana-oren\ntags:\n  - finance\ncreated: '.*'\nstatus: suggested\nurgent: false\nconfidence: normal\n---\n$/,
  )
  assert.deepEqual(
    check(m).issues.filter((i) => i.severity === "error"),
    [],
  )
})

test("a file the released engine wrote is read and accepted, and a missing peer is a warning", () => {
  const root = publishedWorkspace(),
    m = buildModel(root)
  put(
    root,
    "data/users/dana-oren.user.md",
    "---\nname: Dana Oren\ncreated: '2026-11-17T03:47:47+02:00'\nkind: human\nstatus: active\nconfidence: normal\ntasks:\n  - tasks/2026-11-17--call-the-bank\n---\n",
  )
  put(
    root,
    "data/tasks/2026-11-17--call-the-bank.task.md",
    "---\nname: Call the bank\nassignee: users/dana-oren\ntags:\n  - finance\nproject: projects/website\ncreated: '2026-11-17T03:47:47+02:00'\nstatus: suggested\nurgent: false\nconfidence: normal\n---\n",
  )
  put(root, "data/rnd/user-stories/2026-11-15--sign-in.user-story.md", "---\nkey: s1\nname: Sign in\n---\n")
  assert.deepEqual(listIds(m, "rnd/user-stories"), ["2026-11-15--sign-in"])
  assert.deepEqual(get(m, "users/dana-oren").data.tasks, ["tasks/2026-11-17--call-the-bank"])
  const { issues } = check(m)
  assert.deepEqual(
    issues.filter((i) => i.severity === "error"),
    [],
  )
  assert.match(
    issues.map((i) => `${i.where}: ${i.message}`).join("\n"),
    /projects: a peer collection that is declared and not installed — 1 reference/,
  )
})

test("the constraints of the published rnd module give the released engine's verdicts", () => {
  const root = publishedWorkspace(),
    m = buildModel(root)
  add(m, "rnd/products", { name: "Northwind Portal" })
  // pinned from the released engine's check of the same records: a panel needs its rule and members, a published
  // release its repo, tag, cut date, publication date and registries
  put(root, "data/rnd/personas/buyers.persona.md", "---\nname: Buyers\nkind: panel\n---\n")
  put(
    root,
    "data/rnd/releases/northwind-portal/1.0.0.release.md",
    "---\nversion: 1.0.0\nproduct: rnd/products/northwind-portal\nstatus: published\n---\n",
  )
  assert.deepEqual(
    check(m)
      .issues.filter((i) => i.severity === "error" && !i.message.includes("stale"))
      .map((i) => `${i.where} ${i.message.replace(/ — constraint.*/, "")}`),
    [
      "rnd/personas/buyers segment_rule: required",
      "rnd/personas/buyers members: required",
      "rnd/releases/northwind-portal/1.0.0 repo: required",
      "rnd/releases/northwind-portal/1.0.0 tag: required",
      "rnd/releases/northwind-portal/1.0.0 cut_on: required",
      "rnd/releases/northwind-portal/1.0.0 published_on: required",
      "rnd/releases/northwind-portal/1.0.0 published_to: required",
    ],
  )
})

test("next gives the released engine's verdict on every rnd binding, gates through references included", async () => {
  const root = publishedWorkspace()
  const model = buildModel(root)
  const w = (c: string, id: string, f: Record<string, unknown>) => add(model, `rnd/${c}`, f, id)
  w("products", "portal", { name: "Northwind Portal" })
  w("design-docs", "2026-11-01--draft", { name: "Draft", status: "draft" })
  w("design-docs", "2026-11-01--active", { name: "Active", status: "active" })
  const cr = (id: string, status: string, f: Record<string, unknown> = {}) =>
    w("change-requests", id, Object.assign({ key: id, name: id, products: ["rnd/products/portal"], status }, f))
  cr("cr-new", "suggested", { design_docs: ["rnd/design-docs/2026-11-01--draft"] })
  cr("cr-accepted", "accepted", { design_docs: ["rnd/design-docs/2026-11-01--active"] })
  cr("cr-building", "accepted", { design_docs: ["rnd/design-docs/2026-11-01--active"] })
  cr("cr-built", "accepted", { verified_on: "2026-11-10T10:00:00Z" })
  cr("cr-live", "implemented", { verified_on: "2026-11-10T10:00:00Z", deployed_on: "2026-11-11T10:00:00Z" })
  const plan = (id: string, status: string, of: string, f: Record<string, unknown> = {}) =>
    w("implementation-plans", id, Object.assign({ name: id, status, change_request: `rnd/change-requests/${of}` }, f))
  plan("2026-11-02--approved", "approved", "cr-building")
  plan("2026-11-02--done", "done", "cr-built", { code_approved_on: "2026-11-09T10:00:00Z" })
  compile(buildModel(root))
  const ids = listIds(buildModel(root), "rnd/change-requests")
  const ours = commandsFor(buildModel(root), "rnd/change-requests", ids)
  const api = await import("../node_modules/dreamteamer/src/api.js")
  const released = api.commandsFor(new api.Store({ root }), "rnd/change-requests", ids)
  assert.deepEqual(ours, released)
  const implement = ours.commands.find((t) => t.binding === "command-bindings/rnd--implement--change-requests")
  // `implementation_plans.status in approved|in-progress` follows the plan the request lists back
  assert.deepEqual(implement?.eligible, ["cr-building"])
  assert.deepEqual(implement?.done, ["cr-built"])
  assert.equal(implement?.invocation, "/rnd:implement rnd/change-requests/cr-building")
})

test("claude-code gets the released engine's .claude tree and CLAUDE.md, byte for byte", () => {
  const [ours, theirs] = [publishedWorkspace(), publishedWorkspace()]
  for (const root of [ours, theirs]) {
    const pkg = asObject(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "package.json")
    pkg.dreamteamer = { harnesses: ["claude-code"] }
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg))
  }
  const bin = fileURLToPath(new URL("../node_modules/dreamteamer/bin/dreamteamer.js", import.meta.url))
  assert.equal(spawnSync(process.execPath, [bin, "compile"], { cwd: theirs, encoding: "utf8" }).status, 0)
  compile(buildModel(ours))
  const tree = (root: string) =>
    listFiles(join(root, ".claude"))
      .map((t) => relative(root, t))
      .sort()
  assert.deepEqual(tree(ours), tree(theirs))
  assert.ok(tree(ours).length > 40)
  for (const f of [...tree(ours), "CLAUDE.md"])
    assert.equal(readFileSync(join(ours, f), "utf8"), readFileSync(join(theirs, f), "utf8"), f)
})
