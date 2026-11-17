import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dt, put, workspace } from "./helpers.ts"

const read = (ws: string, path: string) => readFileSync(join(ws, path), "utf8")
const quiet = (r: { out: string; err: string }) =>
  assert.doesNotMatch(r.out + r.err, /\n\s+at |node:internal/, "no stack trace")

test("the verb list and the version need no workspace; anything else says what is wrong with the folder", () => {
  const empty = mkdtempSync(join(tmpdir(), "dt-empty-"))
  assert.match(dt(empty).out, /^usage: <verb>/)
  assert.equal(dt(empty).code, 0)
  assert.match(dt(empty, "help").out, /^usage/)
  assert.match(dt(empty, "--version").out, /^dreamteamer-first-principles \d/)
  const r = dt(empty, "check")
  assert.equal(r.code, 1)
  assert.match(r.err, /^✖ not a workspace: .* has no package\.json\n$/)
  put(empty, "package.json", '{"name":"some-lib"}')
  assert.match(dt(empty, "check").err, /no dreamteamer module/)
  assert.match(dt(empty, "compile").err, /no dreamteamer module/)
  assert.equal(existsSync(join(empty, ".dt")), false, "nothing is written into a folder that is not a workspace")
  assert.equal(dt(empty, "frobnicate").code, 2)
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const r = dt(empty, name)
    assert.equal(r.code, 2, name)
    assert.match(r.out, new RegExp(`^unknown verb ${name}\\n`))
  }
})

test("text is stored as it was typed", () => {
  const ws = workspace()
  const titles = [
    "Re: budget",
    "[draft] plan",
    "#1 priority",
    "Fix issue #42",
    "2026",
    "true",
    "null",
    "~",
    "- buy milk",
    "@dana review",
    '"quoted" title',
    "*bold* move",
    "{x} y",
    "| pipe",
    "C:\\new folder",
  ]
  for (const [n, title] of titles.entries()) {
    const r = dt(ws, "add", "memos", "--title", title, "--id", `m${n}`)
    assert.equal(r.code, 0, `${title}: ${r.err}`)
    assert.equal(JSON.parse(dt(ws, "get", `memos/m${n}`).out).title, title)
  }
  assert.equal(dt(ws, "check").code, 0)
})

test("a body that starts with a heading, or spans lines, is kept", () => {
  const ws = workspace()
  dt(ws, "add", "users", "--name", "Sam Diaz", "--notes", "Prefers mornings.")
  assert.equal(dt(ws, "set", "users/sam-diaz", "notes=# Profile\n\nPrefers evenings.").code, 0)
  assert.match(read(ws, "data/users/sam-diaz.user.md"), /---\n# Profile\n\nPrefers evenings\.\n$/)
  assert.equal(dt(ws, "set", "users/sam-diaz", "notes=null").code, 0)
  assert.match(read(ws, "data/users/sam-diaz.user.md"), /---\nnull\n$/, "the word null is text")
  assert.equal(dt(ws, "set", "users/sam-diaz", "notes=").code, 0)
  assert.match(read(ws, "data/users/sam-diaz.user.md"), /---\n$/, "only an empty value clears")
})

test("values are converted by the type of their field", () => {
  const ws = workspace()
  dt(ws, "add", "users", "--name", "Dana Oren")
  const r = dt(
    ws,
    "add",
    "tasks",
    "Call the bank",
    "--assignee",
    "dana-oren",
    "--tags",
    "finance, home",
    "--tags",
    "q4",
    "--urgent",
    "--estimate=3",
    "due=2026-12-01",
  )
  assert.equal(r.code, 0, r.err)
  const id = dt(ws, "list", "task").out.trim()
  const data = JSON.parse(dt(ws, "get", `task/${id}`).out)
  assert.deepEqual(
    [data.name, data.assignee, data.tags, data.urgent, data.estimate, data.due],
    ["Call the bank", "users/dana-oren", ["finance", "home", "q4"], true, 3, "2026-12-01"],
  )
  assert.equal(dt(ws, "set", `tasks/${id}`, "urgent=false", "tags=later").code, 0)
  assert.deepEqual(JSON.parse(dt(ws, "get", `tasks/${id}`).out).tags, ["later"])
  assert.match(dt(ws, "add", "tasks", "--name", "x", "--estimate", "many").err, /estimate: expected an integer/)
  assert.match(dt(ws, "add", "tasks", "--name", "x", "--name", "y").err, /name is given twice/)
  assert.match(dt(ws, "add", "tasks", "--name").err, /--name needs a value/)
})

test("a mistake gets one line that says what to do", () => {
  const ws = workspace()
  dt(ws, "add", "users", "--name", "Dana Oren")
  const cases: [string[], RegExp][] = [
    [
      ["add", "tasks", "--name", "x", "--assigne", "users/dana-oren"],
      /tasks has no field assigne — did you mean assignee\?/,
    ],
    [["add", "tsks", "--name", "x"], /unknown collection tsks — the collections are/],
    [["add", "tasks", "--due", "2026-12-01"], /cannot make an id — give name/],
    [["get"], /get needs a <collection>\/<id> reference/],
    [["set"], /set needs/],
    [["rm"], /rm needs/],
    [["list"], /list needs a collection/],
    [["add"], /add needs a collection/],
    [["get", "users/nobody"], /users\/nobody: no such record/],
    [["get", "nope/x"], /not a <collection>\/<id> reference/],
    [["set", "users/dana-oren"], /nothing to set/],
    [["set", "users/dana-oren", "name.first=x"], /users has no field name\.first/],
    [["list", "tasks", "--sort", "name"], /list does not take --sort — it takes --filter, --json/],
    [["list", "tasks", "--filter", "nope=1"], /no field nope to filter on/],
    [["--strict", "check"], /the verb comes first — got --strict/],
    [["check", "now"], /check does not take "now"/],
    [["rm", "users/../x"], /invalid id/],
  ]
  for (const [args, why] of cases) {
    const r = dt(ws, ...args)
    assert.equal(r.code, 1, args.join(" "))
    assert.match(r.err, why)
    quiet(r)
  }
  assert.deepEqual(readdirSync(join(ws, "data")), ["users"])
})

test("list filters, and prints records as JSON on request", () => {
  const ws = workspace()
  dt(ws, "add", "users", "--name", "Dana Oren")
  dt(ws, "add", "tasks", "Call the bank", "--assignee", "users/dana-oren", "--tags", "finance")
  dt(ws, "add", "tasks", "Water the plants", "--status", "done")
  assert.match(dt(ws, "list", "tasks", "--filter", "status=done").out, /^\d{4}-\d\d-\d\d--water-the-plants\n$/)
  assert.match(
    dt(ws, "list", "tasks", "--filter", "assignee=users/dana-oren", "--filter", "tags=finance").out,
    /--call-the-bank\n$/,
  )
  assert.equal(dt(ws, "list", "tasks", "--filter", "status=done", "--filter", "tags=finance").out, "")
  const rows = JSON.parse(dt(ws, "list", "tasks", "--json").out)
  assert.deepEqual(
    rows.map((r: { data: { name: string } }) => r.data.name),
    ["Call the bank", "Water the plants"],
  )
})

test("a damaged record is reported in one line, and can still be removed", () => {
  const ws = workspace()
  put(ws, "data/users/bad.user.md", "---\nname: [unclosed\n---\n")
  for (const args of [
    ["get", "users/bad"],
    ["set", "users/bad", "kind=agent"],
  ]) {
    const r = dt(ws, ...args)
    assert.equal(r.code, 1)
    assert.match(r.err, /users\/bad: unreadable/)
    quiet(r)
  }
  const c = dt(ws, "check")
  assert.equal(c.code, 1)
  assert.match(c.out, /✖ users\/bad: unreadable/)
  assert.equal(dt(ws, "rm", "users/bad").code, 0)
  assert.equal(dt(ws, "check").code, 0)
})

test("a broken model stops writes and compile, and check says why", () => {
  const ws = workspace()
  put(ws, "modules/local/collections/gadgets.collection.yaml", "name: gadgets\nfields:\n  size: {type: strng}\n")
  for (const args of [["add", "users", "--name", "Dana Oren"], ["compile"]]) {
    const r = dt(ws, ...args)
    assert.equal(r.code, 1)
    assert.match(r.err, /model has errors[\s\S]*gadgets\.size: unknown type "strng"/)
  }
  assert.equal(dt(ws, "check").code, 1)
  assert.equal(existsSync(join(ws, "data")), false)
  assert.equal(existsSync(join(ws, ".dt")), false)
})

test("an option is not mistaken for a field, a value or a command", () => {
  const ws = workspace()
  dt(ws, "add", "users", "--name", "Dana Oren")
  dt(ws, "add", "tasks", "Call the bank", "--assignee", "dana-oren")
  assert.match(dt(ws, "rm", "users/dana-oren", "--force=false").err, /--force takes no value/)
  assert.match(dt(ws, "rm", "users/dana-oren").err, /referenced by 1 record/)
  assert.equal(dt(ws, "rm", "users/dana-oren", "--force").code, 0)
  put(
    ws,
    "modules/local/collections/releases.collection.yaml",
    'name: releases\ndescription: releases.\nids: {from: "{{ version }}"}\nfields:\n  version: {type: string, required: true}\n',
  )
  assert.match(dt(ws, "add", "releases", "--version", "1.2.0").out, /✔ releases\/1\.2\.0/)
  assert.match(dt(ws, "-w").err, /-w needs the path/)
  assert.match(dt("/", `--workspace=${ws}`, "list", "releases").out, /^1\.2\.0\n$/)
})

test("numbers and times are stored as typed or completed, never reinterpreted", () => {
  const ws = workspace()
  assert.match(dt(ws, "add", "tasks", "Hex", "--estimate", "0x10").err, /estimate: expected an integer/)
  assert.equal(dt(ws, "add", "tasks", "Meet", "--at", "2026-12-01 10:00").code, 0)
  const id = dt(ws, "list", "tasks").out.trim()
  assert.match(JSON.parse(dt(ws, "get", `tasks/${id}`).out).at, /^2026-12-01T10:00:00[+-]\d\d:\d\d$/)
  assert.equal(dt(ws, "set", `tasks/${id}`, "at=2026-12-01T10:00:00.250Z").code, 0)
  assert.match(dt(ws, "set", `tasks/${id}`, "at=next week").err, /date and time with a zone/)
})
