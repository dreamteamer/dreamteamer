import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The SKILL.md "verb names, as a map" block promises it cannot drift from the dispatch.
// This test IS that promise: both directions, verb names only (flags stay help's job).
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const cli = fs.readFileSync(path.join(root, "src/cli.ts"), "utf8")
const skill = fs.readFileSync(path.join(root, "skills/using-dreamteamer/SKILL.md"), "utf8")

// The dispatch is the COMMANDS registry in cli.ts — per verb, a lazy `import("./commands/<name>.ts")`
// whose own `<name>` function is called. Either quote and any spacing, so a reformat cannot empty the match.
const entries = [
  ...cli.matchAll(
    /^\s*['"]?([a-z-]+)['"]?\s*:\s*async\b[^\n]*?import\(\s*['"]\.\/commands\/(\w+)\.ts['"]\s*\)\s*\)\s*\.(\w+)\(/gm
  ),
]
// a verb's file and its function are both the camel-cased verb plus `Command`: `rm-field` → rmFieldCommand
const named = (verb: string): string => verb.replace(/-(\w)/g, (_, c) => c.toUpperCase()) + "Command"
for (const [, verb, file, fn] of entries) {
  assert.equal(file, named(verb), `COMMANDS.${verb} loads commands/${file}.ts — expected commands/${named(verb)}.ts`)
  assert.equal(fn, named(verb), `COMMANDS.${verb} calls ${fn} — expected ${named(verb)}`)
}
const dispatch = new Set(entries.map(m => m[1]))
// A PIN THAT MATCHES NOTHING PASSES VACUOUSLY in the SKILL.md → dispatch direction's mirror: an empty
// set would fail the first test loudly, but a half-matching pattern would not — so name a floor.
assert.ok(
  dispatch.size >= 30,
  `read only ${dispatch.size} verbs from cli.ts's COMMANDS — the pattern no longer matches`
)
// Every registered verb has its file, and every file under src/commands/ is registered.
const files = fs
  .readdirSync(path.join(root, "src/commands"))
  .filter(f => f.endsWith(".ts"))
  .map(f => f.slice(0, -3))
  .filter(f => f !== "versionCommand") // `version` is reached by its three spellings, not the grammar
assert.deepEqual(new Set(files), new Set([...dispatch].map(named)), "src/commands/*.ts and cli.ts's COMMANDS disagree")
// ⚠ THERE IS NO SEPARATE SCHEMA-OP TABLE ANY MORE. `SCHEMA_OPS`/`SCHEMA_FIELD_OPS` went with the
// `schema` grammar in 0.19.0 — system entities take the record verbs, and every field verb is
// registered — so `dispatch` alone is the authority.

const block = skill.match(/the verb names, as a map[\s\S]*?\n\n## /)
assert.ok(block, "SKILL.md carries the verb map block")
const mapped = new Set([...block[0].matchAll(/`([a-z-]+)`/g)].map(m => m[1]))

test("every verb SKILL.md names exists in the dispatch", () => {
  for (const v of mapped) {
    assert.ok(dispatch.has(v), `SKILL.md names "${v}" — not in cli.js dispatch`)
  }
})
test("every dispatch verb is named in SKILL.md", () => {
  for (const v of dispatch) assert.ok(mapped.has(v), `dispatch verb "${v}" missing from SKILL.md map`)
})
