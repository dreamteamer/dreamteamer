// `dreamteamer.skills`: a module whose skills run TypeScript ships them BUILT, and declares the build
// folder its skills stage from. Node will not strip types under node_modules, so a skill script is
// `skills/<id>/bin/x.mts` in the source and `dist/skills/<id>/bin/x.mjs` in the build — and before this
// key the only way to stage a `.mjs` was to compile it beside its source. Each install channel is
// exercised with the key and without it; a module without it must behave exactly as before, including
// a plain-JavaScript skill that ships its script in `skills/` with no build at all.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { workspace, compileQuietly, compileError, readFile, dt } from "../helpers/ws.ts"
import { staleness } from "../../src/compile/staleness.ts"
import { readManifest } from "../../src/runtime/runtime.ts"
import type { Workspace } from "../../src/types.ts"

const SKILL = (id: string): string =>
  `---\nname: ${id}\ndescription: "Use when Dana Oren asks Northwind for a greeting."\n---\n\nRun \`node .dreamteamer/skills/${id}/bin/greet.mjs\`.\n`

/**
 * A module package at `dir` shipping skill `greet`. `declare` sets `dreamteamer.skills: dist/skills`;
 * `built` writes that build (the `.mjs` and a copy of SKILL.md); `plainJs` ships the `.mjs` in the source
 * folder itself, the shape of a module that has no build.
 */
function skillModule(
  dir: string,
  name: string,
  { declare = true, built = true, plainJs = false }: { declare?: boolean; built?: boolean; plainJs?: boolean } = {}
): void {
  fs.mkdirSync(path.join(dir, "skills", "greet", "bin"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        type: "module",
        dreamteamer: { description: "Greets the Northwind team.", ...(declare ? { skills: "dist/skills" } : {}) },
      },
      null,
      "\t"
    ) + "\n"
  )
  fs.writeFileSync(path.join(dir, "skills", "greet", "SKILL.md"), SKILL("greet"))
  fs.writeFileSync(
    path.join(dir, "skills", "greet", "bin", plainJs ? "greet.mjs" : "greet.mts"),
    plainJs ? 'console.log("hello")\n' : 'const who: string = "Sam Diaz"\nconsole.log(who)\n'
  )
  if (built) {
    fs.mkdirSync(path.join(dir, "dist", "skills", "greet", "bin"), { recursive: true })
    fs.writeFileSync(path.join(dir, "dist", "skills", "greet", "SKILL.md"), SKILL("greet"))
    fs.writeFileSync(path.join(dir, "dist", "skills", "greet", "bin", "greet.mjs"), 'console.log("Sam Diaz")\n')
  }
}

/** Turn on the two skill-mirroring harnesses and declare `dep` as `npm install` would, when given. */
function declareDep(root: string, dep?: [name: string, spec: string]): Workspace {
  const pkgFile = path.join(root, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
  if (dep) pkg.dependencies = { ...pkg.dependencies, [dep[0]]: dep[1] }
  pkg.dreamteamer.harnesses = ["claude-code", "codex"]
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
  return { root, pkg }
}

/** The four channels a module arrives through, each placing `@acme/greeter` and returning the workspace. */
const CHANNELS: Record<string, (opts?: Parameters<typeof skillModule>[2]) => { ws: Workspace; moduleRoot: string }> = {
  "a copy under modules/": opts => {
    const { root } = workspace({ compile: false })
    const moduleRoot = path.join(root, "modules", "greeter")
    skillModule(moduleRoot, "greeter", opts)
    return { ws: declareDep(root), moduleRoot }
  },
  "a git_modules/ clone": opts => {
    const { root } = workspace({ compile: false })
    const moduleRoot = path.join(root, "git_modules", "greeter")
    skillModule(moduleRoot, "@acme/greeter", opts)
    return { ws: declareDep(root), moduleRoot }
  },
  "an npm package": opts => {
    const { root } = workspace({ compile: false })
    const moduleRoot = path.join(root, "node_modules", "@acme", "greeter")
    skillModule(moduleRoot, "@acme/greeter", opts)
    return { ws: declareDep(root, ["@acme/greeter", "1.0.0"]), moduleRoot }
  },
  // what `dt install ./folder` leaves behind: npm links node_modules/<name> to the folder and saves a
  // file: spec (the real install is driven end to end in install-modules.test.ts)
  "a folder install (dt install ./path)": opts => {
    const { root } = workspace({ compile: false })
    const moduleRoot = path.join(root, "vendor", "greeter")
    skillModule(moduleRoot, "@acme/greeter", opts)
    fs.mkdirSync(path.join(root, "node_modules", "@acme"), { recursive: true })
    fs.symlinkSync(moduleRoot, path.join(root, "node_modules", "@acme", "greeter"))
    return { ws: declareDep(root, ["@acme/greeter", "file:vendor/greeter"]), moduleRoot }
  },
}

const sourcesOf = (root: string, runtimePath: string): string[] =>
  (readManifest(root)?.entries?.[runtimePath]?.sources ?? []).map(s => (typeof s === "string" ? s : s.path))

for (const [channel, place] of Object.entries(CHANNELS)) {
  describe(`skills on ${channel}`, () => {
    test("with dreamteamer.skills: staged from the build — the compiled script, never the .mts beside its source", () => {
      const { ws, moduleRoot } = place()
      const { code } = compileQuietly(ws)
      assert.equal(code, 0)
      const at = path.join(ws.root, ".dreamteamer", "skills", "greet")
      assert.equal(readFile(ws.root, ".dreamteamer/skills/greet/bin/greet.mjs"), 'console.log("Sam Diaz")\n')
      assert.ok(!fs.existsSync(path.join(at, "bin", "greet.mts")), "the source .mts must not be staged")
      const [src] = sourcesOf(ws.root, "skills/greet/SKILL.md")
      const rel = path.relative(ws.root, moduleRoot).split(path.sep).join("/")
      // a folder install compiles through its node_modules link, the path discovery walks
      assert.match(src, /dist\/skills\/greet\/SKILL\.md$/, src)
      if (!channel.startsWith("a folder")) assert.equal(src, `${rel}/dist/skills/greet/SKILL.md`)
      // the harness adapters read the same staged files
      assert.ok(fs.existsSync(path.join(ws.root, ".claude", "skills", "greet", "bin", "greet.mjs")))
      assert.ok(fs.existsSync(path.join(ws.root, ".agents", "skills", "greet", "bin", "greet.mjs")))
      assert.ok(!fs.existsSync(path.join(ws.root, ".claude", "skills", "greet", "bin", "greet.mts")))
    })

    test("without the key: skills/ is staged as it is, a plain-JavaScript script included — no build needed", () => {
      const { ws } = place({ declare: false, built: false, plainJs: true })
      const { code } = compileQuietly(ws)
      assert.equal(code, 0)
      assert.equal(readFile(ws.root, ".dreamteamer/skills/greet/bin/greet.mjs"), 'console.log("hello")\n')
      const [src] = sourcesOf(ws.root, "skills/greet/SKILL.md")
      assert.match(src, /\/skills\/greet\/SKILL\.md$/)
      assert.doesNotMatch(src, /dist\//)
      assert.ok(fs.existsSync(path.join(ws.root, ".claude", "skills", "greet", "bin", "greet.mjs")))
    })

    test("without the key, a dist/skills/ the module happens to have is NOT read", () => {
      const { ws } = place({ declare: false, built: true })
      compileQuietly(ws)
      assert.ok(fs.existsSync(path.join(ws.root, ".dreamteamer", "skills", "greet", "bin", "greet.mts")))
      assert.ok(!fs.existsSync(path.join(ws.root, ".dreamteamer", "skills", "greet", "bin", "greet.mjs")))
    })

    test("a declared folder that was never built fails compile, naming the folder and the build", () => {
      const { ws } = place({ built: false })
      const err = compileError(ws)
      assert.ok(err, "compile must refuse an unbuilt module")
      assert.match(err, /dreamteamer\.skills names \S*dist\/skills\/, which is missing/)
      assert.match(err, /Run the module's build \(`npm run build` in /)
    })
  })
}

describe("dreamteamer.skills — the edges", () => {
  const modulesCopy = CHANNELS["a copy under modules/"]

  test("an EMPTY declared folder fails compile as empty", () => {
    const { ws, moduleRoot } = modulesCopy({ built: false })
    fs.mkdirSync(path.join(moduleRoot, "dist", "skills"), { recursive: true })
    fs.writeFileSync(path.join(moduleRoot, "dist", "skills", ".gitkeep"), "")
    assert.match(compileError(ws) ?? "", /modules\/greeter\/dist\/skills\/, which is empty/)
  })

  test("a path outside the package, or not a string, is refused", () => {
    for (const bad of ["../elsewhere", "/abs/skills", 7]) {
      const { ws, moduleRoot } = modulesCopy()
      const pkgFile = path.join(moduleRoot, "package.json")
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
      pkg.dreamteamer.skills = bad
      fs.writeFileSync(pkgFile, JSON.stringify(pkg))
      assert.match(
        compileError(ws) ?? "",
        /dreamteamer\.skills must be a relative path inside the package/,
        String(bad)
      )
    }
  })

  test("the workspace's own package.json may not declare it", () => {
    const { ws } = workspace({ compile: false, pkg: { skills: "dist/skills" } })
    assert.match(compileError(ws) ?? "", /dreamteamer\.skills belongs to a module package, not the workspace/)
  })

  test("the skill counts toward compile's summary, and the orientation lists it under its module", () => {
    const { ws } = modulesCopy()
    const { stdout } = compileQuietly(ws)
    const withKey = Number(/(\d+) skills/.exec(stdout.join("\n"))?.[1])
    const { ws: plain } = modulesCopy({ declare: false, built: false, plainJs: true })
    const without = Number(/(\d+) skills/.exec(compileQuietly(plain).stdout.join("\n"))?.[1])
    assert.equal(withKey, without, "the built skill counts exactly as a source one does")
    assert.match(readFile(ws.root, "AGENTS.md") ?? "", /skills: [^\n]*greet/)
  })

  test("staleness watches the build folder: a rebuilt skill is stale, an edit to the unbuilt source is not", () => {
    const { ws, moduleRoot } = modulesCopy()
    compileQuietly(ws)
    assert.deepEqual(staleness(ws.root).stale, [])
    fs.mkdirSync(path.join(moduleRoot, "skills", "wave"), { recursive: true })
    fs.writeFileSync(path.join(moduleRoot, "skills", "wave", "SKILL.md"), SKILL("wave"))
    assert.deepEqual(staleness(ws.root).stale, [], "the source of the build is not what compile reads")
    fs.mkdirSync(path.join(moduleRoot, "dist", "skills", "wave"), { recursive: true })
    fs.writeFileSync(path.join(moduleRoot, "dist", "skills", "wave", "SKILL.md"), SKILL("wave"))
    assert.ok(
      staleness(ws.root).stale.some(s => s.includes("modules/greeter/dist/skills/wave/SKILL.md")),
      JSON.stringify(staleness(ws.root).stale)
    )
  })

  test("the entity verbs refuse to write into a build output, and name the source", () => {
    const { ws } = modulesCopy()
    compileQuietly(ws)
    const set = dt(ws.root, "set", "skills/greet", "description=Use when Sam Diaz waves.")
    assert.equal(set.code, 1, set.stdout)
    assert.match(set.stderr, /staged from modules\/greeter's build \(dreamteamer\.skills: "dist\/skills"\)/)
    assert.match(set.stderr, /modules\/greeter\/skills\/greet\//)
    const rm = dt(ws.root, "rm", "skills/greet")
    assert.equal(rm.code, 1)
    assert.match(rm.stderr, /staged from modules\/greeter's build/)
    assert.ok(fs.existsSync(path.join(ws.root, "modules", "greeter", "dist", "skills", "greet", "SKILL.md")))
    const add = dt(ws.root, "add", "skills", "--module", "greeter", "--name", "wave", "--description", "Waves.")
    assert.equal(add.code, 1, add.stdout)
    assert.match(add.stderr, /staged from modules\/greeter's build/)
    assert.ok(!fs.existsSync(path.join(ws.root, "modules", "greeter", "skills", "wave")))
  })
})
