import { test } from "node:test"
import { execFileSync } from "node:child_process"
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
    "--urgent",
    "--estimate=3",
    "due=2026-12-01",
  )
  assert.equal(r.code, 0, r.err)
  const id = dt(ws, "list", "task").out.trim()
  const data = JSON.parse(dt(ws, "get", `task/${id}`).out)
  assert.deepEqual(
    [data.name, data.assignee, data.tags, data.urgent, data.estimate, data.due],
    ["Call the bank", "users/dana-oren", ["finance", "home"], true, 3, "2026-12-01"],
  )
  assert.equal(dt(ws, "set", `tasks/${id}`, "urgent=false", "tags=later").code, 0)
  assert.deepEqual(JSON.parse(dt(ws, "get", `tasks/${id}`).out).tags, ["later"])
  // a list field given more than once takes each value whole, commas and all, as the released command line does
  assert.equal(dt(ws, "set", `tasks/${id}`, "tags=north, south", "--tags", "east").code, 0)
  assert.deepEqual(JSON.parse(dt(ws, "get", `tasks/${id}`).out).tags, ["north, south", "east"])
  assert.equal(dt(ws, "add", "tasks", "Plan", "--tags", "a,b", "--tags", "c", "--id", "plan").code, 0)
  assert.deepEqual(JSON.parse(dt(ws, "get", "tasks/plan").out).tags, ["a,b", "c"])
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

test("next prints which bound commands apply to a record, and in which state", () => {
  const ws = workspace()
  put(ws, "modules/local/commands/review.command.md", "---\nname: lab/review\n---\nReview.\n")
  put(ws, "modules/local/commands/plan.command.md", "---\nname: plan\n---\nPlan.\n")
  put(
    ws,
    "modules/local/command-bindings/review--tasks.command-binding.yaml",
    "command: commands/review\ncollection: collections/tasks\navailable_when: {_or: [{status: {_eq: todo}}, {assignee: {kind: {_eq: agent}}}]}\ndone_when: {status: {_eq: done}}\n",
  )
  put(
    ws,
    "modules/local/command-bindings/plan--tasks.command-binding.yaml",
    "command: commands/plan\ncollection: collections/tasks\nscope: collection\n",
  )
  dt(ws, "add", "tasks", "Call the bank", "--id", "call")
  dt(ws, "add", "tasks", "Water the plants", "--id", "water", "--status", "done")
  assert.equal(
    dt(ws, "next", "task/call").out,
    "lab/review  [record]  1/1 eligible\n  /lab:review tasks/call\nplan  [collection]  /plan tasks\n",
  )
  assert.equal(
    dt(ws, "next", "tasks", "--ids", "call,water").out.split("\n")[0],
    "lab/review  [record]  1/2 eligible, 1 done",
  )
  assert.match(dt(ws, "next", "tasks").out, /^lab\/review {2}\[record\] {2}\(no ids given\)\n/)
  assert.deepEqual(JSON.parse(dt(ws, "next", "tasks/water", "--json").out).commands[0].states, { water: "done" })
  assert.equal(dt(ws, "next", "memos").out, "(no commands bound to memos)\n")
  const r = dt(ws, "next", "nothing/here")
  quiet(r)
  assert.equal(r.code, 1)
})

test("extensions add verbs, checks and notes; one that fails or claims a verb already owned is one line", () => {
  const ws = workspace()
  const pkg = JSON.parse(read(ws, "package.json"))
  put(ws, "package.json", JSON.stringify(Object.assign(pkg, { dreamteamer: { disable: ["modules/off"] } })))
  const ext = (name: string, code: string) => {
    put(ws, `modules/${name}/package.json`, JSON.stringify({ name, dreamteamer: { extension: "./x.mjs" } }))
    put(ws, `modules/${name}/x.mjs`, `export const apiVersion = 1\nexport default ${code}\n`)
  }
  ext(
    "alpha",
    `(dt) => ({
      commands: { hello: { run: (ws, argv) => { console.log("hello", ...argv, typeof dt.Store); return 3 } } },
      check: async () => [{ file: "data/x", message: "looks odd", warning: true }, { message: "is wrong" }],
      next: ({ ids }) => [...ids.map((id) => ({ id, text: "noted" })), { id: "other", text: "dropped" }],
      setup: [],
    })`,
  )
  ext("beta", `() => ({ commands: { hello: { run: () => 0 } } })`)
  ext("gamma", `() => { throw new Error("boom") }`)
  ext("delta", `() => ({ commands: { list: { run: () => 0 } } })`)
  ext("off", `() => { throw new Error("never loaded") }`)
  const r = dt(ws, "hello", "a", "b")
  assert.deepEqual([r.code, r.out], [3, "hello a b function\n"])
  assert.deepEqual(r.err.trim().split("\n"), [
    '✖ extension beta contributes the command "hello", which alpha already owns — uninstall one, or switch it off: add "modules/beta" to dreamteamer.disable in package.json',
    '✖ extension delta contributes the command "list", which the engine already owns — uninstall one, or switch it off: add "modules/delta" to dreamteamer.disable in package.json',
    "✖ extension gamma: activate(dt) failed — boom",
    "✖ extension people: its entry ./x.mjs did not load — " + r.err.split("did not load — ")[1]?.split("\n")[0],
  ])
  const c = dt(ws, "check")
  assert.equal(c.code, 1)
  assert.match(c.out, /⚠ data\/x: looks odd \(alpha\)\n✖ alpha: is wrong \(alpha\)\n.* 1 errors · 1 warnings\n$/)
  dt(ws, "add", "tasks", "Call the bank", "--id", "call")
  assert.equal(dt(ws, "next", "tasks/call").out, "(no commands bound to tasks)\n● tasks/call — noted (alpha)\n")
  assert.equal(dt(ws, "list", "tasks").err, "", "a verb that needs no extension loads none")
})

/** a workspace that is a git repository with one commit, and a way to run git in it */
function repo() {
  const ws = workspace()
  const g = (...a: string[]) => execFileSync("git", a, { cwd: ws, encoding: "utf8" })
  g("init", "-q")
  g("config", "user.name", "Dana Oren")
  g("config", "user.email", "dana@northwind.example")
  g("add", "-A")
  g("commit", "-qm", "first")
  return { ws, g }
}

test("commit publishes the record files it is given, or all that are pending, and nothing else", () => {
  const { ws, g } = repo()
  dt(ws, "add", "users", "--name", "Dana Oren")
  dt(ws, "add", "tasks", "Call the bank", "--id", "call")
  put(ws, "notes.txt", "not a record\n")
  const r = dt(ws, "commit", "tasks/call", "-m", "Plan the week")
  const sha = g("rev-parse", "--short", "HEAD").trim()
  assert.equal(r.code, 0, r.err)
  assert.equal(
    r.out,
    `✔ workspace ${sha} — Plan the week\nrecords — tasks: 1 created\n  created  tasks/call  data/tasks/call.task.md  · committed ${sha}\n`,
  )
  assert.equal(g("status", "--porcelain"), "?? data/users/\n?? notes.txt\n")
  dt(ws, "set", "tasks/call", "status=done")
  assert.match(
    dt(ws, "commit", "--dry-run").out,
    /^✔ workspace \(dry run\) — dreamteamer: 2 changes across tasks, users\n/,
  )
  assert.match(dt(ws, "commit", "users").out, /— dreamteamer: users add dana-oren\n/)
  assert.match(dt(ws, "commit").out, /— dreamteamer: tasks set call\n.*\n {2}updated  tasks\/call /)
  assert.equal(dt(ws, "commit").out, "nothing pending\n")
  const bad = dt(ws, "commit", "tasks/nobody")
  quiet(bad)
  assert.deepEqual([bad.code, bad.err], [1, "✖ tasks/nobody: no such record\n"])
  assert.equal(g("status", "--porcelain"), "?? notes.txt\n")
})

test("changes prints the record report of what is written and not committed", () => {
  const { ws } = repo()
  assert.equal(dt(ws, "changes").out, "✔ no record changes since HEAD\n")
  dt(ws, "add", "users", "--name", "Dana Oren")
  dt(ws, "add", "tasks", "Call the bank", "--id", "call")
  assert.equal(
    dt(ws, "changes").out,
    [
      "records — tasks: 1 created · users: 1 created",
      "  created  tasks/call  data/tasks/call.task.md  · uncommitted",
      "  created  users/dana-oren  data/users/dana-oren.user.md  · uncommitted",
      "2 record change(s) since HEAD — 2 uncommitted",
      "",
    ].join("\n"),
  )
  assert.equal(JSON.parse(dt(ws, "changes", "--json").out).events.length, 2)
})

test("resolve renders the workspace's declared variables, in text or in a record's field", () => {
  const { ws } = repo()
  const pkg = JSON.parse(read(ws, "package.json"))
  put(ws, "package.json", JSON.stringify(Object.assign(pkg, { dreamteamer: { vars: ["FILES_FOLDER"] } })))
  put(ws, ".env", "FILES_FOLDER='/srv/files'\n")
  assert.equal(dt(ws, "resolve", "${env:FILES_FOLDER}/a b").out, "/srv/files/a b\n")
  assert.equal(dt(ws, "resolve", "nope/q3").out, "nope/q3\n", "text that names no record is itself")
  dt(ws, "add", "tasks", "Read", "--id", "read", "--tags", "${env:FILES_FOLDER}/x,${env:FILES_FOLDER}/y")
  assert.equal(dt(ws, "resolve", "task/read", "tags").out, "/srv/files/x\n/srv/files/y\n")
  for (const [args, re] of [
    [["${env:HOME}"], /"HOME" is not declared in dreamteamer.vars/],
    [["tasks/read", "due"], /has no field "due"/],
    [["tasks/read"], /needs a field/],
    [["text", "more"], /takes one text/],
  ] as const) {
    const r = dt(ws, "resolve", ...args)
    quiet(r)
    assert.equal(r.code, 1, args.join(" "))
    assert.match(r.err, re)
  }
})

test("rename moves a record and rewrites the records that name it", () => {
  const { ws } = repo()
  dt(ws, "add", "users", "--name", "Dana Oren")
  dt(ws, "add", "tasks", "Call the bank", "--id", "call", "--assignee", "dana-oren")
  const r = dt(ws, "rename", "user/dana-oren", "dana")
  assert.equal(r.out, "✔ renamed users/dana-oren → users/dana\n✔ rewrote the references in 1 file(s)\n")
  assert.equal(JSON.parse(dt(ws, "get", "tasks/call").out).assignee, "users/dana")
  assert.deepEqual(JSON.parse(dt(ws, "get", "users/dana").out).tasks, ["tasks/call"])
  assert.equal(existsSync(join(ws, "data/users/dana-oren.user.md")), false)
  assert.match(dt(ws, "rename", "tasks/call", "../x").err, /^✖ /)
  assert.match(dt(ws, "rename", "users/dana", "dana").err, /already exists/)
  assert.match(dt(ws, "rename", "users/dana").err, /needs the new id/)
})

test("values lists what a field holds, most used first, or its declared values", () => {
  const { ws } = repo()
  dt(ws, "add", "tasks", "One", "--id", "one", "--tags", "home,errand")
  dt(ws, "add", "tasks", "Two", "--id", "two", "--tags", "home")
  assert.equal(dt(ws, "values", "tasks", "tags").out, "    2  home\n    1  errand\n— 2 distinct, from data\n")
  assert.equal(dt(ws, "values", "task", "status").out, "todo\ndone\n— 2 distinct, from enum\n")
  assert.match(dt(ws, "values", "tasks", "tags", "--limit", "1").out, /— 2 distinct \(showing 1\), from data\n$/)
  assert.equal(dt(ws, "values", "tasks", "notes").out, "(tasks.notes is a body field — no value vocabulary)\n")
  assert.equal(dt(ws, "values", "tasks", "due").out, "(no values set on tasks.due)\n")
  assert.match(dt(ws, "values", "tasks", "nope").err, /unknown field "nope"/)
})

test("history lists a record's commits, newest first", () => {
  const { ws } = repo()
  dt(ws, "add", "tasks", "Call the bank", "--id", "call")
  assert.equal(dt(ws, "history", "tasks/call").out, "(no history for tasks/call — not committed yet)\n")
  dt(ws, "commit", "tasks")
  dt(ws, "set", "tasks/call", "status=done")
  dt(ws, "commit", "-m", "Done")
  const day = "\\d{4}-\\d{2}-\\d{2}"
  assert.match(
    dt(ws, "history", "task/call").out,
    new RegExp(`^[0-9a-f]{7}  ${day}  Dana Oren  Done\n[0-9a-f]{7}  ${day}  Dana Oren  dreamteamer: tasks add call\n$`),
  )
  assert.equal(JSON.parse(dt(ws, "history", "tasks/call", "--json").out).length, 2)
})
