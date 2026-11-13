// The README and the setup reference describe the CLI; `dt help` IS the CLI. This test holds the two
// together: every `npx dreamteamer <verb> [--flag]` line in a README code fence, and every `dt <verb>
// [--flag]` line in the skill's setup reference, names a verb and flags that USAGE prints. A verb the
// docs promise and the engine lacks is a red test, not a reader's surprise. The reference is also held
// to the design's rule that it never names a module: an agent that reads it learns the contract, not a
// vendor list.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { USAGE } from "../../src/cli.ts"
import { ENGINE_ROOT } from "../helpers/ws.js"

const README = fs.readFileSync(path.join(ENGINE_ROOT, "README.md"), "utf8")
const SETUP_REF = path.join(ENGINE_ROOT, "skills", "using-dreamteamer", "references", "setup.md")

/** The verbs USAGE documents: the first word of every two-space-indented line that starts a verb entry,
 *  plus the record verbs it lists inline. */
function usageVerbs(usage) {
  const verbs = new Set()
  for (const line of usage.split("\n")) {
    const m = /^ {2}([a-z][a-z-]*)\b/.exec(line)
    if (m) verbs.add(m[1])
  }
  return verbs
}
const usageFlags = usage => new Set([...usage.matchAll(/--([a-z][a-z-]*)/g)].map(m => m[1]))

/** Every `<bin> <verb> …` command line inside ``` fences of a markdown text. */
function commandLines(markdown, bin) {
  const out = []
  let inFence = false
  for (const raw of markdown.split("\n")) {
    if (raw.trim().startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (!inFence) continue
    const line = raw.replace(/#.*$/, "").trim()
    const re = new RegExp(`(?:^|&&\\s*|\\|\\s*)${bin} ([a-z][a-z-]*)((?:\\s+\\S+)*)`)
    const m = re.exec(line)
    if (m) out.push({ line: raw.trim(), verb: m[1], flags: [...m[2].matchAll(/--([a-z][a-z-]*)/g)].map(x => x[1]) })
  }
  return out
}

const verbs = usageVerbs(USAGE)
const flags = usageFlags(USAGE)

describe("README names only verbs and flags dt help prints", () => {
  const lines = commandLines(README, "npx dreamteamer")
  test("the README has command lines to hold", () => assert.ok(lines.length >= 4, `found ${lines.length}`))
  for (const l of lines) {
    test(l.line, () => {
      assert.ok(verbs.has(l.verb), `verb "${l.verb}" is not in dt help`)
      for (const f of l.flags) assert.ok(flags.has(f), `flag --${f} is not in dt help`)
    })
  }
})

describe("the setup reference names only verbs and flags dt help prints, and no module", () => {
  const text = fs.readFileSync(SETUP_REF, "utf8")
  const lines = [...commandLines(text, "dt"), ...commandLines(text, "npx dreamteamer")]
  test("the reference has command lines to hold", () => assert.ok(lines.length >= 3, `found ${lines.length}`))
  for (const l of lines) {
    test(l.line, () => {
      assert.ok(verbs.has(l.verb), `verb "${l.verb}" is not in dt help`)
      for (const f of l.flags) assert.ok(flags.has(f), `flag --${f} is not in dt help`)
    })
  }
  test("names no module", () => {
    const named = [...text.matchAll(/@dreamteamer\/[a-z-]+/g)].map(m => m[0])
    assert.deepEqual(
      named,
      [],
      `the reference names ${named.join(", ")} — it must teach the contract, never a vendor list`
    )
  })
})
