// Held-out (0.49.1, rnd/tests/dreamteamer/held-out-0491-update-fresh-compile): `dt update` compiles with the
// version npm just installed — what the NEW extension contributes (a source kind, an analyze refusal) is what
// the compile sees — while a refused compile still restores the old version and its runtime, a nav fragment
// is still merged and committed, and `dt install` of a fresh extension is unchanged. Every package is built
// here in a temp dir and packed into an offline folder for --from. Synthetic data only.
import { test, describe, before } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { workspace, ENGINE_ROOT, git, readFile } from "../helpers/ws.ts"
import { readNavDoc } from "../../src/nav.ts"

const BIN = path.join(ENGINE_ROOT, "bin", "dreamteamer.js")
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dt-home-"))
const ENV = {
  PATH: process.env.PATH,
  HOME,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
}
const run = (root, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 240_000,
    killSignal: "SIGKILL",
    env: ENV,
  })
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}
const ok = r => assert.equal(r.code, 0, r.stderr + r.stdout)

// ---- the packages ---------------------------------------------------------------------------------
const ext = contribution => `export const apiVersion = 1;\nexport default () => (${contribution});\n`
const THINGS =
  'name: hxthings\nids:\n  from: "{{ name | slug }}"\nfields:\n  name:\n    type: string\n    required: true\n  notes:\n    type: markdown\n    body: true\n'
const PACKAGES = [
  // a version whose NEW extension refuses the compile (analyze error); the old one compiled a kind
  {
    name: "@hx/badkind",
    version: "1.0.0",
    files: { "entry.js": ext("{ sourceKinds: ['widgets'] }"), "widgets/w.md": "# w\n" },
  },
  {
    name: "@hx/badkind",
    version: "1.1.0",
    files: {
      "entry.js": ext(
        "{ sourceKinds: ['widgets'], analyze: () => ({ errors: ['badkind 1.1.0 refuses this workspace'] }) }"
      ),
      "widgets/w.md": "# w\n",
    },
  },
  // a version that gains a source kind AND ships a nav fragment placing its own collection
  { name: "@hx/navkind", version: "1.0.0", files: { "entry.js": ext("{}") } },
  {
    name: "@hx/navkind",
    version: "1.1.0",
    nav: "nav.yaml",
    files: {
      "entry.js": ext("{ sourceKinds: ['gizmos'] }"),
      "gizmos/g.md": "# g\n",
      "collections/hxthings.collection.yaml": THINGS,
      "nav.yaml": "tree:\n  - folder: Hx\n    items: [hxthings]\n",
    },
  },
  // a module preset whose member gains a source kind
  { name: "@hx/member", version: "1.0.0", files: { "entry.js": ext("{}") } },
  {
    name: "@hx/member",
    version: "1.1.0",
    files: { "entry.js": ext("{ sourceKinds: ['doohickeys'] }"), "doohickeys/d.md": "# d\n" },
  },
  { name: "@hx/kset", version: "1.0.0", preset: { "@hx/member": "1.0.0" }, files: {} },
  { name: "@hx/kset", version: "1.1.0", preset: { "@hx/member": "1.1.0" }, files: {} },
  // a first install of an extension contributing a kind
  {
    name: "@hx/fresh",
    version: "1.0.0",
    files: { "entry.js": ext("{ sourceKinds: ['thingamajigs'] }"), "thingamajigs/t.md": "# t\n" },
  },
]
let REG
before(() => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "dt-hx-src-"))
  REG = fs.mkdtempSync(path.join(os.tmpdir(), "dt-hx-reg-"))
  for (const p of PACKAGES) {
    const dir = path.join(src, `${p.name.replace("@", "").replace("/", "-")}-${p.version}`)
    fs.mkdirSync(dir, { recursive: true })
    for (const [rel, body] of Object.entries(p.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), body)
    }
    const dreamteamer = { description: `${p.name} — a synthetic held-out package` }
    if (p.files["entry.js"]) dreamteamer.extension = "./entry.js"
    if (p.preset) dreamteamer.preset = p.preset
    if (p.nav) dreamteamer.nav = p.nav
    const top = [...new Set(Object.keys(p.files).map(f => f.split("/")[0]))]
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify(
        { name: p.name, version: p.version, description: p.name, type: "module", files: top, dreamteamer },
        null,
        "\t"
      ) + "\n"
    )
    const r = spawnSync("npm", ["pack", dir, "--pack-destination", REG, "--silent"], {
      encoding: "utf8",
      timeout: 60_000,
    })
    if (r.status !== 0) throw new Error(`npm pack ${p.name}@${p.version}: ${r.stderr}`)
  }
})

function offline() {
  const ws = workspace()
  const pkgFile = path.join(ws.root, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
  pkg.dependencies = { ...pkg.dependencies, dreamteamer: `file:${ENGINE_ROOT}` }
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
  git(ws.root, ["add", "-A"])
  if (git(ws.root, ["status", "--porcelain"])) git(ws.root, ["commit", "-qm", "fixture: offline engine"])
  return ws
}
const installed = (root, name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version
  } catch {
    return null
  }
}
const runtimeKinds = root => {
  const m = readFile(root, ".dreamteamer/manifest.yaml") ?? ""
  const at = m.indexOf("source-kinds:")
  return at === -1 ? [] : [...m.slice(at).matchAll(/^\s*-?\s*kind:\s*(\S+)/gm)].map(x => x[1])
}
const has = (root, rel) => fs.existsSync(path.join(root, rel))
const lastFiles = root => git(root, ["show", "--name-only", "--pretty=", "HEAD"]).split("\n").filter(Boolean)

describe("held-out 0.49.1 — dt update compiles with the version npm just installed", () => {
  test("a new version whose compile fails: exit 1, the old version restored, the runtime still the old one", () => {
    const ws = offline()
    ok(run(ws.root, ["install", "@hx/badkind@1.0.0", "--from", REG]))
    assert.ok(runtimeKinds(ws.root).includes("widgets"), readFile(ws.root, ".dreamteamer/manifest.yaml"))
    const pkg = readFile(ws.root, "package.json"),
      lock = readFile(ws.root, "package-lock.json")
    const head = git(ws.root, ["rev-parse", "HEAD"])
    const r = run(ws.root, ["update", "@hx/badkind@1.1.0", "--from", REG])
    assert.equal(r.code, 1, `the 1.1.0 extension refuses the compile, so the update must: ${r.stderr}${r.stdout}`)
    assert.match(r.stderr, /badkind 1\.1\.0 refuses this workspace/)
    assert.equal(readFile(ws.root, "package.json"), pkg, "package.json restored")
    assert.equal(readFile(ws.root, "package-lock.json"), lock, "package-lock.json restored")
    assert.equal(installed(ws.root, "@hx/badkind"), "1.0.0", "node_modules restored")
    assert.ok(runtimeKinds(ws.root).includes("widgets"), "the old version's kind is still compiled")
    assert.ok(has(ws.root, ".dreamteamer/widgets/w.md"))
    assert.equal(git(ws.root, ["rev-parse", "HEAD"]), head, "nothing committed")
  })

  test("a new version that gains a source kind and ships a nav fragment: kind compiled, nav.yaml merged and committed with the update", () => {
    const ws = offline()
    ok(run(ws.root, ["install", "@hx/navkind@1.0.0", "--from", REG]))
    const r = run(ws.root, ["update", "@hx/navkind@1.1.0", "--from", REG])
    ok(r)
    assert.equal(installed(ws.root, "@hx/navkind"), "1.1.0")
    assert.ok(runtimeKinds(ws.root).includes("gizmos"), readFile(ws.root, ".dreamteamer/manifest.yaml"))
    assert.ok(has(ws.root, ".dreamteamer/gizmos/g.md"))
    assert.ok(JSON.stringify(readNavDoc(ws.root).tree).includes("hxthings"), readFile(ws.root, "nav.yaml"))
    assert.match(git(ws.root, ["log", "-1", "--pretty=%s"]), /^dreamteamer: update @hx\/navkind 1\.0\.0 → 1\.1\.0$/)
    assert.ok(lastFiles(ws.root).includes("nav.yaml"), lastFiles(ws.root).join(","))
    assert.equal(git(ws.root, ["status", "--porcelain"]), "")
  })

  test("a module preset whose member gains a source kind: one update, the member's kind compiled", () => {
    const ws = offline()
    ok(run(ws.root, ["install", "@hx/kset@1.0.0", "--from", REG]))
    assert.equal(installed(ws.root, "@hx/member"), "1.0.0")
    const r = run(ws.root, ["update", "@hx/kset", "--from", REG])
    ok(r)
    assert.equal(installed(ws.root, "@hx/member"), "1.1.0")
    assert.ok(runtimeKinds(ws.root).includes("doohickeys"), readFile(ws.root, ".dreamteamer/manifest.yaml"))
    assert.ok(has(ws.root, ".dreamteamer/doohickeys/d.md"))
    assert.match(git(ws.root, ["log", "-1", "--pretty=%s"]), /^dreamteamer: update @hx\/kset 1\.0\.0 → 1\.1\.0/)
    assert.equal(git(ws.root, ["status", "--porcelain"]), "")
  })

  test("dt install of a fresh extension contributing a kind is unchanged: compiled in the same call", () => {
    const ws = offline()
    ok(run(ws.root, ["install", "@hx/fresh@1.0.0", "--from", REG]))
    assert.ok(runtimeKinds(ws.root).includes("thingamajigs"), readFile(ws.root, ".dreamteamer/manifest.yaml"))
    assert.ok(has(ws.root, ".dreamteamer/thingamajigs/t.md"))
    assert.equal(git(ws.root, ["status", "--porcelain"]), "")
  })
})
