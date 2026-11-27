// Tier 2 — the `html` field type, through the real CLI, compile gate, store and check.
//
// What the type promises: `dt add-field --type html` declares one and the workspace still compiles and
// checks clean; a value over the field's limit is refused before disk and reported by `dt check` when
// it arrives by hand; the limit is the field's `maxLength`, or 204,800 characters when it declares none.
// Invented names only — this engine is published.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { workspace, simpleCollection, seedOnce, copyWorkspace, readFile, WS_MODULE } from "../helpers/ws.ts"
import { load } from "../../src/lib/yaml.ts"

const LIMIT = 204_800
const SOURCE = `modules/${WS_MODULE}/collections/pages.collection.yaml`

const ok = (res: { code: number | null; stdout: string; stderr: string }) =>
  assert.equal(res.code, 0, res.stdout + res.stderr)

/** A workspace whose `pages` collection got its html field from `dt add-field`, and one record. */
const seeded = seedOnce(() => {
  const w = workspace({ collections: { pages: simpleCollection() }, records: { pages: [{ name: "Welcome" }] } })
  ok(w.dt("add-field", "pages", "--name", "page", "--type", "html"))
  return w
})
const fresh = () => {
  const w = copyWorkspace(seeded())
  return { ...w, dt: (...a: string[]) => w.dt(...a) }
}
const pageOf = (root: string, id: string): unknown =>
  load<any>(readFile(root, `data/pages/${id}.page.md`)!.split("---")[1]).page

describe("html: a field type", () => {
  test("dt add-field --type html writes type: html, and the workspace compiles and checks clean", () => {
    const w = fresh()
    assert.deepEqual(load<any>(readFile(w.root, SOURCE)!).fields.page, { type: "html" })
    ok(w.dt("compile"))
    ok(w.dt("check"))
    const compiled = load<any>(readFile(w.root, ".dreamteamer/collections/pages.collection.yaml")!)
    // the default is supplied by compile onto the resolved field, and recorded as a default, never as authored
    assert.equal(compiled.compiled.fields.page.type, "html")
    assert.equal(compiled.compiled.fields.page.maxLength, LIMIT)
    assert.equal(compiled.compiled.defaults.fields.page.maxLength, LIMIT)
    assert.equal(compiled.fields.page.maxLength, undefined, "the authored field stays as written")
  })

  test("dt help lists html among the field types", () => {
    const w = fresh()
    const res = w.dt("help")
    assert.match(res.stdout, /types: string markdown html boolean/)
  })
})

describe("html: the limit", () => {
  test("with no maxLength, 204,800 characters are written and 204,801 are refused with nothing written", () => {
    const w = fresh()
    const ref = "pages/welcome"
    const atLimit = "<p>" + "é".repeat(LIMIT - 7) + "</p>" // characters, not bytes: é is two bytes in UTF-8
    assert.equal(atLimit.length, LIMIT)
    ok(w.dt("set", ref, `page=${atLimit}`))
    assert.equal(pageOf(w.root, "welcome"), atLimit)

    const before = readFile(w.root, "data/pages/welcome.page.md")
    const over = atLimit + "x"
    const res = w.dt("set", ref, `page=${over}`)
    assert.notEqual(res.code, 0, "a value one character over the default limit is refused")
    assert.match(res.stdout + res.stderr, /page/)
    assert.equal(readFile(w.root, "data/pages/welcome.page.md"), before, "the refused write changed nothing on disk")
  })

  test("dt add refuses an over-limit page and writes no record", () => {
    const w = fresh()
    const res = w.dt("add", "pages", "Too long", "--page", "x".repeat(LIMIT + 1))
    assert.notEqual(res.code, 0)
    assert.equal(fs.existsSync(path.join(w.root, "data/pages/too-long.page.md")), false)
  })

  test("a declared maxLength is the limit instead of the default", () => {
    const w = fresh()
    const file = path.join(w.root, SOURCE)
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace("    type: html\n", "    type: html\n    maxLength: 10\n")
    )
    assert.equal(load<any>(fs.readFileSync(file, "utf8")).fields.page.maxLength, 10)
    ok(w.dt("compile"))
    const compiled = load<any>(readFile(w.root, ".dreamteamer/collections/pages.collection.yaml")!)
    assert.equal(compiled.compiled.fields.page.maxLength, 10)
    assert.equal(
      compiled.compiled.defaults.fields?.page?.maxLength,
      undefined,
      "an authored maxLength is not a default"
    )
    ok(w.dt("set", "pages/welcome", "page=<b>ok</b>"))
    assert.notEqual(w.dt("set", "pages/welcome", "page=<b>too long</b>").code, 0)
  })

  test("dt check reports a hand-edited page over the limit and exits non-zero", () => {
    const w = fresh()
    ok(w.dt("check"))
    const file = path.join(w.root, "data/pages/welcome.page.md")
    const text = fs.readFileSync(file, "utf8")
    fs.writeFileSync(file, text.replace(/^---\n/, `---\npage: ${"x".repeat(LIMIT + 1)}\n`))
    const res = w.dt("check")
    assert.notEqual(res.code, 0)
    assert.match(res.stdout + res.stderr, /welcome[\s\S]*page|page[\s\S]*welcome/)
  })
})
