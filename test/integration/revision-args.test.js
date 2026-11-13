// Tier 2 — a revision a caller hands to git is a commit id or HEAD, never an option.
//
// historyDiff, store.revert and deriveEvents put a caller's string into git's argv as a revision.
// git reads a revision that starts with a dash as an option, and some of its options write files,
// so each entry point checks the string BEFORE git runs and passes it after `--end-of-options`.
// The assertion that matters is "nothing was written": a refused revision leaves every file as it was.
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { workspace, simpleCollection, readFile, ENGINE_ROOT } from "../helpers/ws.js"
import { historyDiff } from "../../src/history.ts"
import { deriveEvents } from "../../src/events.ts"

const TASKS = simpleCollection({ storage: { suffix: "task" } })
const NOT_A_COMMIT = /is not a commit id/

let tmp
before(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dt-revision-args-"))
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A file outside the workspace that a refused revision must leave alone. */
function victim(name) {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, "KEEP ME\n")
  return p
}
const untouched = p => {
  assert.equal(fs.readFileSync(p, "utf8"), "KEEP ME\n", `${p} was written`)
  assert.equal(fs.existsSync(`${p}~1`), false, `${p}~1 was created`)
}

/** One `tasks/t` record committed twice: the first sha has name T, HEAD has name U. */
function twoRevisions() {
  const ws = workspace({ collections: { tasks: TASKS } })
  ws.store.add("tasks", { name: "T" })
  ws.git(["add", "-A"])
  ws.git(["commit", "-qm", "add t"])
  const first = ws.git(["rev-parse", "HEAD"])
  ws.store.set("tasks", "t", { name: "U" })
  ws.git(["add", "-A"])
  ws.git(["commit", "-qm", "set t"])
  return { ws, first }
}

describe("a revision handed to git is a commit id or HEAD", () => {
  test("sec01-eng-t1: dt diff --hash and historyDiff refuse an option-shaped hash and write nothing", () => {
    const { ws } = twoRevisions()
    const cli = victim("cli.txt")
    const res = ws.dt("diff", "tasks/t", `--hash=--output=${cli}`)
    assert.notEqual(res.code, 0, res.stdout)
    assert.match(res.stderr, NOT_A_COMMIT)
    untouched(cli)

    const api = victim("api.txt")
    assert.throws(() => historyDiff(ws.store, "tasks", "t", `--output=${api}`), NOT_A_COMMIT)
    untouched(api)
  })

  test("sec01-eng-t2: store.revert and dt revert refuse an option-shaped hash; the record is unchanged", () => {
    const { ws } = twoRevisions()
    const before = readFile(ws.root, "data/tasks/t.task.md")
    const api = victim("revert-api.txt")
    assert.throws(() => ws.store.revert("tasks", "t", `--output=${api}`), NOT_A_COMMIT)
    const cli = victim("revert-cli.txt")
    const res = ws.dt("revert", "tasks/t", `--hash=--output=${cli}`)
    assert.notEqual(res.code, 0, res.stdout)
    assert.match(res.stderr, NOT_A_COMMIT)
    assert.equal(readFile(ws.root, "data/tasks/t.task.md"), before)
    untouched(api)
    untouched(cli)
  })

  test("sec01-eng-t3: deriveEvents refuses an option-shaped since or to", () => {
    const { ws } = twoRevisions()
    const since = victim("since.txt")
    assert.throws(
      () => deriveEvents(ws.root, ws.store.descriptors, `--output=${since}`),
      /neither a date \(YYYY-MM-DD\) nor a commit/
    )
    const to = victim("to.txt")
    assert.throws(() => deriveEvents(ws.root, ws.store.descriptors, "2000-01-01", `--output=${to}`), NOT_A_COMMIT)
    untouched(since)
    untouched(to)
  })

  test("sec01-eng-t4: commit ids and HEAD still work, HEAD~n and a date still work for since, and nothing else is a revision", () => {
    const { ws, first } = twoRevisions()
    const head = ws.git(["rev-parse", "HEAD"])
    for (const hash of [head, head.slice(0, 7), head.toUpperCase(), "HEAD"]) {
      assert.match(historyDiff(ws.store, "tasks", "t", hash).diff, /\+name: U/, hash)
    }
    assert.match(historyDiff(ws.store, "tasks", "t").diff, /\+name: U/, "the default is HEAD")
    const ids = events => events.map(e => `${e.collection}/${e.id}`)
    // accepted, not refused: both commits share a second here, so which events HEAD~1 resolves to
    // is a timing matter this test does not pin
    assert.ok(Array.isArray(deriveEvents(ws.root, ws.store.descriptors, "HEAD~1")))
    assert.ok(ids(deriveEvents(ws.root, ws.store.descriptors, "2000-01-01")).includes("tasks/t"))

    for (const bad of ["main", "HEAD^", "HEAD~1", "", "abc", "a".repeat(41), `${head}\n`, ` ${head}`, 1234, [head]]) {
      assert.throws(() => historyDiff(ws.store, "tasks", "t", bad), NOT_A_COMMIT, JSON.stringify(bad))
      assert.throws(() => ws.store.revert("tasks", "t", bad), NOT_A_COMMIT, JSON.stringify(bad))
    }
    assert.match(readFile(ws.root, "data/tasks/t.task.md"), /name: U/, "no refused revert wrote")

    ws.store.revert("tasks", "t", first)
    assert.equal(ws.store.read("tasks", "t").fields.name, "T")
  })

  // The check above refuses first, so a run cannot tell whether git would also have been told where
  // options end. Read it from the source: every argv that carries a caller's revision says so.
  test("sec01-eng-t5: each git argv that carries a caller revision puts --end-of-options before it", () => {
    // one quote style and one space, so formatting (quotes, a wrapped argv, a trailing comma) cannot change what is read
    const src = f =>
      fs
        .readFileSync(path.join(ENGINE_ROOT, "src", f), "utf8")
        .replace(/"/g, "'")
        .replace(/\s+/g, " ")
        .replace(/\[ /g, "[")
        .replace(/,? \]/g, "]")
    const argvs = [
      ["history.ts", /\['diff', '--end-of-options', `\$\{hash\}~1`, hash, '--'/],
      ["store.ts", /\['show', '--end-of-options', `\$\{hash\}:\$\{relPath\}`\]/],
      ["store.ts", /\['ls-tree', '-r', '--name-only', '--end-of-options', hash, '--'/],
      ["events.ts", /\['show', '-s', '--format=%cI', '--end-of-options', from\]/],
      ["events.ts", /\['diff', '--name-status', '-z', '--end-of-options', `\$\{fromSha\}\.\.\$\{to\}`, '--'/],
    ]
    for (const [file, re] of argvs) assert.match(src(file), re, `${file}: ${re}`)
  })
})
