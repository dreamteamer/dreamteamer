// The record-change report (0.42.0) — `dt changes` measures what a turn changed, `dt commit` prints
// the same block for what it published, and the using-dreamteamer skill tells a session to end its
// reply with it. Driven through the real CLI on an HQ workspace.
//
// ⚠ Each assertion is about what was PRINTED for records that were really written, never that a
// flag parsed.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { workspace, simpleCollection, copyWorkspace, dt, git, ENGINE_ROOT } from "../helpers/ws.ts"
import type { Fixture } from "../helpers/ws.ts"
import { reportLine } from "../../src/changes/lib/reportLine.ts"
import { groupChanges } from "../../src/changes/groupChanges.ts"

const contacts = simpleCollection({ storage: { suffix: "contact" } })
const meetings = simpleCollection({ storage: { suffix: "meeting" } })
const issues = simpleCollection({ storage: { suffix: "issue" } })

/**
 * An HQ (contacts, meetings, issues), seeded and committed: two contacts and a meeting.
 *
 * BUILT ONCE PER FILE, then copied per test: seeding is several `dt` launches and a compile, the same
 * state every time, and it was the larger part of every test here. Each copy is a separate workspace
 * with its own git history, so no test sees another's writes.
 */
let template: Fixture | undefined
function seeded() {
  template ??= buildSeeded()
  return copyWorkspace(template)
}

function buildSeeded(): Fixture {
  const hq = workspace({ collections: { contacts, meetings, issues } })
  for (const name of ["Dana Oren", "Harbor Mutual Desk"])
    assert.equal(dt(hq.root, "add", "contacts", "--name", name).code, 0)
  assert.equal(dt(hq.root, "add", "meetings", "--name", "Kickoff").code, 0)
  assert.equal(dt(hq.root, "commit", "-m", "seed").code, 0)
  return hq
}

/** The CR's walk: one contact added, two set, one meeting removed, one issue added. */
function fiveWrites(hq) {
  for (const args of [
    ["add", "contacts", "--name", "Sam Diaz"],
    ["set", "contacts/dana-oren", "notes=Met at the Northwind offsite."],
    ["set", "contacts/harbor-mutual-desk", "notes=Renewal due in March."],
    ["rm", "meetings/kickoff"],
    ["add", "issues", "--name", "Login times out"],
  ]) {
    const res = dt(hq.root, ...args)
    assert.equal(res.code, 0, `${args.join(" ")}: ${res.stderr}`)
  }
}

/**
 * Make sure the next commit lands in a LATER second than `base`: `--since <sha>` resolves the sha to its
 * commit DATE and `--before` is inclusive at second precision, so a commit in the same second reads as
 * the base. Waits only when `base` was committed in the current second — with a copied template it
 * usually was not, and the wait was a fixed second per test.
 */
function afterCommitSecond(root: string, base: string) {
  const at = Number(git(root, ["show", "-s", "--format=%ct", base]))
  while (Math.floor(Date.now() / 1000) <= at) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
}

const LINE = "records — contacts: 1 created, 2 updated · issues: 1 created · meetings: 1 deleted"

describe("dt changes — what this turn changed", () => {
  test("five writes: five records, each with ref, path and committed:false", () => {
    const hq = seeded()
    fiveWrites(hq)
    const res = dt(hq.root, "changes", "--json")
    assert.equal(res.code, 0, res.stderr)
    const out = JSON.parse(res.stdout)
    assert.equal(out.since, "HEAD")
    assert.deepEqual(
      out.events.map(e => [e.ref, e.change, e.path, e.committed]),
      [
        ["contacts/dana-oren", "updated", "data/contacts/dana-oren.contact.md", false],
        ["contacts/harbor-mutual-desk", "updated", "data/contacts/harbor-mutual-desk.contact.md", false],
        ["contacts/sam-diaz", "created", "data/contacts/sam-diaz.contact.md", false],
        ["issues/login-times-out", "created", "data/issues/login-times-out.issue.md", false],
        ["meetings/kickoff", "deleted", "data/meetings/kickoff.meeting.md", false],
      ]
    )
    assert.ok(
      out.events.every(e => !("layer" in e)),
      "no layer key"
    )
    assert.equal(out.events.find(e => e.ref === "issues/login-times-out").repo, ".")
    assert.equal(
      out.events.find(e => e.ref === "contacts/sam-diaz").type,
      "item-added",
      "the 0.41.0 key is kept for old readers"
    )
    assert.deepEqual(out.collections, [
      { collection: "contacts", created: 1, updated: 2, deleted: 0 },
      { collection: "issues", created: 1, updated: 0, deleted: 0 },
      { collection: "meetings", created: 0, updated: 0, deleted: 1 },
    ])
  })

  test("the human output opens with the report line, then one row per record with its path, then the count", () => {
    const hq = seeded()
    fiveWrites(hq)
    const res = dt(hq.root, "changes")
    assert.equal(res.code, 0, res.stderr)
    const lines = res.stdout.trimEnd().split("\n")
    assert.equal(lines[0], LINE)
    assert.match(
      res.stdout,
      /^ {2}created {2}contacts\/sam-diaz {2}data\/contacts\/sam-diaz\.contact\.md {2}· uncommitted$/m
    )
    assert.match(
      res.stdout,
      /^ {2}deleted {2}meetings\/kickoff {2}data\/meetings\/kickoff\.meeting\.md {2}· uncommitted$/m
    )
    assert.match(
      res.stdout,
      /^ {2}created {2}issues\/login-times-out {2}data\/issues\/login-times-out\.issue\.md {2}· uncommitted$/m
    )
    assert.equal(lines.length, 7, res.stdout)
    assert.equal(lines[6], "5 record change(s) since HEAD — 5 uncommitted")
    // the line the verb prints IS the pure function's, so the skill's format and the verb cannot drift
    assert.equal(lines[0], reportLine(groupChanges(JSON.parse(dt(hq.root, "changes", "--json").stdout).events)))
  })

  test("--since <sha>: the commits since then are folded in, each record saying whether it is committed", () => {
    const hq = seeded()
    const base = git(hq.root, ["rev-parse", "HEAD"])
    afterCommitSecond(hq.root, base)
    fiveWrites(hq)
    assert.equal(dt(hq.root, "commit", "contacts/sam-diaz", "meetings/kickoff").code, 0)
    assert.deepEqual(
      JSON.parse(dt(hq.root, "changes", "--json").stdout).events.map(e => e.ref),
      ["contacts/dana-oren", "contacts/harbor-mutual-desk", "issues/login-times-out"],
      "HEAD: what is still uncommitted"
    )
    const res = dt(hq.root, "changes", "--since", base, "--json")
    assert.equal(res.code, 0, res.stderr)
    assert.deepEqual(
      JSON.parse(res.stdout).events.map(e => [e.ref, e.change, e.committed]),
      [
        ["contacts/dana-oren", "updated", false],
        ["contacts/harbor-mutual-desk", "updated", false],
        ["contacts/sam-diaz", "created", true],
        ["issues/login-times-out", "created", false],
        ["meetings/kickoff", "deleted", true],
      ]
    )
    assert.match(
      dt(hq.root, "changes", "--since", base).stdout,
      /^ {2}created {2}contacts\/sam-diaz {2}data\/contacts\/sam-diaz\.contact\.md {2}· committed$/m
    )
  })

  test("nothing written: nothing reported", () => {
    const hq = seeded()
    const res = dt(hq.root, "changes")
    assert.equal(res.code, 0)
    assert.equal(res.stdout.trim(), "✔ no record changes since HEAD")
    assert.deepEqual(JSON.parse(dt(hq.root, "changes", "--json").stdout).events, [])
  })

  test('--since with no value is refused rather than read as a ref called "undefined"', () => {
    const hq = seeded()
    const res = dt(hq.root, "changes", "--since")
    assert.notEqual(res.code, 0)
    assert.match(res.stderr, /--since needs a commit or a date/)
  })
})

describe("dt commit prints the same block for what it published", () => {
  test("one report line and one row per published record, each with its sha", () => {
    const hq = seeded()
    fiveWrites(hq)
    const res = dt(hq.root, "commit", "-m", "the five")
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, new RegExp(`^${LINE}$`, "m"))
    const hqSha = git(hq.root, ["rev-parse", "--short", "HEAD"])
    assert.match(
      res.stdout,
      new RegExp(
        `^ {2}created {2}contacts/sam-diaz {2}data/contacts/sam-diaz\\.contact\\.md {2}· committed ${hqSha}$`,
        "m"
      )
    )
    assert.match(
      res.stdout,
      new RegExp(
        `^ {2}created {2}issues/login-times-out {2}data/issues/login-times-out\\.issue\\.md {2}· committed ${hqSha}$`,
        "m"
      )
    )
    assert.equal((res.stdout.match(/· committed /g) ?? []).length, 5, res.stdout)
    assert.equal(dt(hq.root, "changes").stdout.trim(), "✔ no record changes since HEAD", "and nothing is left")
  })

  test("a dry run prints the block too, every row uncommitted", () => {
    const hq = seeded()
    fiveWrites(hq)
    const res = dt(hq.root, "commit", "--dry-run")
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, new RegExp(`^${LINE}$`, "m"))
    assert.equal((res.stdout.match(/· uncommitted/g) ?? []).length, 5, res.stdout)
  })
})

describe("the rule a session follows — in the skill, and one sentence in the harness block", () => {
  const skill = fs.readFileSync(path.join(ENGINE_ROOT, "skills", "using-dreamteamer", "SKILL.md"), "utf8")
  const section = skill.slice(skill.indexOf("## a reply that wrote records ends with the record report"))

  test("the skill carries the rule and the format", () => {
    assert.ok(skill.includes("## a reply that wrote records ends with the record report"), "the section exists")
    const body = section.slice(0, section.indexOf("\n## ", 4))
    for (const must of [
      "dt changes", // measured, not recalled
      "--since", // a turn that committed midway
      "records — contacts: 1 created, 2 updated", // the line, as the verb prints it
      "(data/issues/login-times-out.issue.md)", // a record's link is its workspace path
      "[contacts/sam-diaz](data/contacts/sam-diaz.contact.md)", // a record is a link to its file
      "meetings/kickoff (deleted)", // a deleted record is its ref, unlinked
      "nothing written, nothing appended",
      "measured, not attributed", // review r1-03: the verb cannot say whose; rows left out are counted, never dropped silently
      "pending rows left out",
    ])
      assert.ok(body.includes(must), `the section says ${must}`)
  })

  test("the compiled CLAUDE.md repeats the rule in one sentence and points at the skill", () => {
    const hq = seeded()
    const claude = fs.readFileSync(path.join(hq.root, "CLAUDE.md"), "utf8")
    assert.match(
      claude,
      /a reply that wrote records ends with the record report `dt changes` prints — the format is in the skill/
    )
  })
})
