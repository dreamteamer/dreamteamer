// `--workspace <path>` / `-w` — the one flag that runs a verb in another workspace (0.41.0).
//
// The target is a PATH to a workspace root, resolved against the current directory and pinned for this
// process only. Pinned here: a path resolves and the record lands THERE, `--workspace=<x>` is the same flag,
// a missing or non-workspace target is refused with nothing written, and `--vault` is still honoured as
// an alias.
//
// ⚠ Each assertion is about where the record LANDED, never that the flag parsed.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { workspace, simpleCollection, dt, dtIn, ENGINE_ROOT } from "../helpers/ws.ts"

/** An HQ workspace and a project workspace beside it, both compiled, both carrying `widgets`. */
function hqAndProject() {
  const widgets = simpleCollection({ storage: { suffix: "widget" } })
  const hq = workspace({ collections: { widgets } })
  const proj = workspace({ collections: { widgets } })
  return { hq, proj, rel: path.relative(hq.root, proj.root) }
}

const gearbox = root => path.join(root, "data", "widgets", "gearbox.widget.md")

describe("-w / --workspace targets a workspace by PATH", () => {
  test("a path resolves: the record lands in that workspace, never in the one the command ran from", () => {
    const { hq, proj, rel } = hqAndProject()
    const res = dt(hq.root, "add", "widgets", "--name", "Gearbox", "-w", rel)
    assert.equal(res.code, 0, res.stderr)
    assert.ok(fs.existsSync(gearbox(proj.root)), "the record is in the target")
    assert.ok(!fs.existsSync(gearbox(hq.root)), "and not in the workspace around the command")
  })

  test("--workspace is the same flag, and the verb after it runs in the target (list)", () => {
    const { hq, proj, rel } = hqAndProject()
    assert.equal(dt(hq.root, "add", "widgets", "--name", "Gearbox", "--workspace", rel).code, 0)
    assert.equal(dt(hq.root, "add", "widgets", "--name", "Flywheel").code, 0)
    assert.ok(fs.existsSync(gearbox(proj.root)))
    assert.deepEqual(dt(hq.root, "list", "widgets", "-w", rel).stdout.trim().split("\n"), ["gearbox"])
    assert.deepEqual(dt(hq.root, "list", "widgets").stdout.trim().split("\n"), ["flywheel"])
  })

  test("--workspace=<x> is honoured exactly like --workspace <x>", () => {
    const { hq, proj, rel } = hqAndProject()
    const res = dt(hq.root, "add", "widgets", "--name", "Gearbox", `--workspace=${rel}`)
    assert.equal(res.code, 0, res.stderr)
    assert.ok(fs.existsSync(gearbox(proj.root)))
  })

  test("a missing path, a folder that is not a workspace, and a bare flag are refused; nothing is written", () => {
    const { hq } = hqAndProject()
    const missing = dt(hq.root, "add", "widgets", "--name", "Gearbox", "-w", "project-z")
    assert.notEqual(missing.code, 0)
    assert.match(missing.stderr, /--workspace project-z — no such directory/)
    fs.mkdirSync(path.join(hq.root, "sub", "project-a"), { recursive: true })
    const plain = dtIn(path.join(hq.root, "sub"), "add", "widgets", "--name", "Gearbox", "-w", "project-a")
    assert.notEqual(plain.code, 0)
    assert.match(
      plain.stderr,
      /--workspace project-a — .*sub\/project-a is not a workspace \(no package\.json with a "dreamteamer" section\)/
    )
    const bare = dt(hq.root, "list", "widgets", "-w")
    assert.notEqual(bare.code, 0)
    assert.match(bare.stderr, /--workspace needs a path to a workspace/)
    assert.ok(!fs.existsSync(gearbox(hq.root)), "nothing was written")
  })

  test("--vault still works as a silent alias", () => {
    const { hq, proj, rel } = hqAndProject()
    const res = dtIn(hq.root, "--vault", rel, "add", "widgets", "--name", "Gearbox")
    assert.equal(res.code, 0, res.stderr)
    assert.ok(fs.existsSync(gearbox(proj.root)))
    assert.doesNotMatch(res.stderr, /deprecated/, "silent")
  })

  test("dt help documents --workspace / -w and marks --vault deprecated", () => {
    const out = dt(path.dirname(path.dirname(hqAndProject().hq.root)), "help").stdout
    assert.match(out, /--workspace, -w <path>/)
    assert.match(out, /--vault <path>\s+deprecated/)
  })

  test("the -w pin never reaches another process: an environment variable changes nothing", () => {
    const { hq, proj } = hqAndProject()
    assert.equal(dt(proj.root, "add", "widgets", "--name", "Gearbox").code, 0)
    const inProject = env =>
      spawnSync(process.execPath, [path.join(ENGINE_ROOT, "bin", "dreamteamer.js"), "list", "widgets"], {
        cwd: path.join(proj.root, "data"),
        env: { ...process.env, ...env },
        encoding: "utf8",
      }).stdout.trim()
    assert.equal(inProject({}), "gearbox")
    assert.equal(inProject({ DREAMTEAMER_WORKSPACE: fs.realpathSync(hq.root) }), "gearbox", "a hand-set variable")
  })
})
