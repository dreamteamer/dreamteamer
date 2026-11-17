// Delivery to an agent harness, and the stamp that says when it is stale.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildModel } from "../src/model/buildModel.ts"
import { check } from "../src/store/check.ts"
import { compile } from "../src/compile/compile.ts"
import { STAMP } from "../src/harness/deliver.ts"
import { asObject } from "../src/lib/asObject.ts"
import { put, workspace } from "./helpers.ts"

const BEGIN = "<!-- dreamteamer:begin (generated — do not edit inside this block) -->"
const RULES = "<!-- dreamteamer:instructions:begin -->"

function harnesses(root: string, list?: string[]) {
  const pkg = asObject(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "package.json")
  pkg.dreamteamer = list ? { harnesses: list } : {}
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg))
}

function stale(root: string) {
  return check(buildModel(root)).issues.filter((t) => t.message.startsWith("stale"))
}

test("compile delivers skills, agents and commands to claude-code, with the orientation block in CLAUDE.md", () => {
  const root = workspace()
  const p = (path: string, text: string) => put(root, `modules/local/${path}`, text)
  p("skills/triage/SKILL.md", "---\nname: triage\ndescription: use when sorting.\n---\nSort.\n")
  p("skills/triage/bin/sort.py", "print('sorted')\n")
  p("commands/lab/run.command.md", "---\ndescription: run it\n---\nRun.\n")
  p(
    "agents/helper.agent.md",
    "---\nname: helper\ndescription: helps\ntools: [Read, Bash]\nskills: [skills/triage]\n---\nHelp.\n",
  )
  p(
    "command-bindings/run--tasks.command-binding.yaml",
    "command: commands/lab/run\ncollection: collections/tasks\navailable_when: {_and: [{status: {_eq: todo}}, {due: {_nempty: true}}]}\ndone_when: {status: {_in: [done]}}\n",
  )
  put(root, "DREAMTEAMER.md", "Always say please.\n")
  put(root, "CLAUDE.md", "My own notes.\n")
  harnesses(root, ["claude-code"])
  compile(buildModel(root))
  const at = (path: string) => readFileSync(join(root, path), "utf8")
  assert.equal(
    at(".claude/skills/triage/SKILL.md"),
    `---\nname: triage\ndescription: use when sorting.\n---\nSort.\n\n${STAMP}\n`,
  )
  assert.equal(at(".claude/skills/triage/bin/sort.py"), "print('sorted')\n", "a script is copied as it is")
  assert.equal(at(".claude/commands/lab/run.md"), `---\ndescription: run it\n---\nRun.\n\n${STAMP}\n`)
  assert.equal(
    at(".claude/agents/helper.md"),
    `---\nname: helper\ndescription: helps\ntools:\n  - Read\n  - Bash\n---\n\nALWAYS load these skills (Skill tool) before acting: triage.\n\nHelp.\n\n${STAMP}\n`,
  )
  assert.ok(existsSync(join(root, ".claude/skills/using-dreamteamer/SKILL.md")), "the system module's skill too")
  const md = at("CLAUDE.md")
  assert.ok(md.startsWith(`${BEGIN}\nthis workspace is a typed record DSL operated by dreamteamer v0.49.1`))
  assert.match(md, /\n<!-- dreamteamer:end -->\n\n<!-- dreamteamer:instructions:begin -->\nAlways say please\.\n/)
  assert.ok(md.endsWith("<!-- dreamteamer:instructions:end -->\n\nMy own notes.\n"), "the workspace's own text stays")
  assert.match(
    md,
    /\n\*\*Local\*\* \(`local` · modules\/local\)\n {2}skills: triage · commands: \/lab:run\n- companies/,
  )
  assert.match(md, /\n- tasks — tasks\.\n {4}write: required name; status enum\(2\)\n/)
  assert.match(md, /\n- tasks — \/lab:run \(available when: status=todo, due set · done when: status in done\)\n/)
  compile(buildModel(root))
  assert.equal(at("CLAUDE.md"), md, "a second compile changes nothing")

  rmSync(join(root, "modules/local/commands"), { recursive: true })
  rmSync(join(root, "modules/local/command-bindings"), { recursive: true })
  compile(buildModel(root))
  assert.equal(existsSync(join(root, ".claude/commands")), false, "a command that went is removed, with its folders")
  harnesses(root, [])
  compile(buildModel(root))
  assert.equal(at("CLAUDE.md"), "My own notes.\n", "a harness switched off loses its block")
  assert.equal(existsSync(join(root, ".claude")), false)
})

test("a workspace that names no harness gets no harness files; a root file holding only blocks is removed", () => {
  const root = workspace()
  compile(buildModel(root))
  assert.equal(existsSync(join(root, ".claude")) || existsSync(join(root, "CLAUDE.md")), false)
  harnesses(root, ["claude-code", "codex"])
  assert.match(compile(buildModel(root)).at(-1) ?? "", /^harnesses claude-code, codex → \d+ files$/)
  assert.ok(existsSync(join(root, "CLAUDE.md")))
  assert.equal(existsSync(join(root, "AGENTS.md")) || existsSync(join(root, ".agents")), false, "codex is not served")
  harnesses(root, [])
  compile(buildModel(root))
  assert.equal(existsSync(join(root, "CLAUDE.md")), false)
})

test("check says when a source changed since the last compile, and compile clears it", () => {
  const root = workspace()
  assert.deepEqual(stale(root), [], "nothing before the first compile")
  compile(buildModel(root))
  assert.deepEqual(stale(root), [])
  put(
    root,
    "modules/local/collections/memos.collection.yaml",
    "name: memos\ndescription: memos.\nfields:\n  title: {type: string}\n",
  )
  put(root, "DREAMTEAMER.md", "Rules.\n")
  const [w] = stale(root)
  assert.equal(w.severity, "warning")
  assert.match(
    w.message,
    /^stale — 2 source\(s\) differ since the last compile \(DREAMTEAMER\.md, modules\/local\/collections\/memos\.collection\.yaml\); run compile$/,
  )
  compile(buildModel(root))
  assert.deepEqual(stale(root), [])
})
