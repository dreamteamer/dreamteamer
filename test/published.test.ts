// The engine against real published modules, at the versions pinned in this repository's devDependencies.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { add } from "../src/store/add.ts"
import { buildModel } from "../src/model/buildModel.ts"
import { check } from "../src/store/check.ts"
import { get } from "../src/store/get.ts"
import { listIds } from "../src/store/listIds.ts"
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
