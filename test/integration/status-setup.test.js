// `dt status` gains a setup section and `dt doctor` renders a unit's checks as rows — both read-only,
// both from the unit's own inspect, never from a stored flag. The probe reaches every state.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { workspace, withProbeSetup, ENGINE_ROOT, git, treeHash } from "../helpers/ws.js"

const BIN = path.join(ENGINE_ROOT, "bin", "dreamteamer.js")
const run = (root, args, env = {}) => {
  const home = path.join(root, ".home")
  fs.mkdirSync(home, { recursive: true })
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      ...env,
    },
  })
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}
const probed = () => {
  const ws = workspace({ compile: false })
  withProbeSetup(ws.root)
  git(ws.root, ["add", "-A"])
  git(ws.root, ["commit", "-qm", "fixture: probe"])
  const c = run(ws.root, ["compile"])
  assert.equal(c.code, 0, c.stderr)
  return ws
}
/** The unit's line in the SETUP section (the modules section above it lists the same names). */
const line = (out, unit) =>
  (out.split("setup:\n")[1] ?? "").split("\n").find(l => new RegExp(`^  ${unit}\\s`).test(l)) ?? ""

describe("dt status — the setup section", () => {
  test("every state the probe can reach renders as the design's line, with the next command", () => {
    const ws = probed()
    const tok = path.join(ws.root, "tok")
    fs.writeFileSync(tok, "x", { mode: 0o600 })
    fs.chmodSync(tok, 0o600)
    // a world-readable token in the environment is refused by status exactly as setup refuses it: its own row, the fix
    const loose = path.join(ws.root, "loose-tok")
    fs.writeFileSync(loose, "x", { mode: 0o644 })
    fs.chmodSync(loose, 0o644)
    const refused = run(ws.root, ["status", "--json"], { PROBE_TOKEN_PATH: loose })
    const probeLine = JSON.parse(refused.stdout).setup.find(l => l.unit === "probe")
    assert.match(probeLine.checks.find(c => c.id === "probe.token").detail, /readable by other users — chmod 600/)
    assert.match(
      probeLine.checks.find(c => c.id === "probe.token" && c.title === "token file" && /unset/.test(c.detail))
        ? "unit saw unset"
        : "unit saw it",
      /unit saw unset/
    )
    const home = path.join(ws.root, "phome")
    // nothing done yet: configured, with what is missing, pointing at dt setup
    let s = run(ws.root, ["status"])
    assert.equal(s.code, 0, s.stderr)
    assert.match(
      line(s.stdout, "probe"),
      /^ {2}probe\s+configured\s+probe home missing · label missing · token file missing · weights missing · tuned missing · live check unverified\s+→ dt setup probe/
    )
    // no evidence is never ready
    assert.match(line(run(ws.root, ["status"], { PROBE_EMPTY: "1" }).stdout, "probe"), /no evidence/)
    // after the safe part and the consequential effects: still configured until verified
    assert.equal(
      run(
        ws.root,
        [
          "setup",
          "probe",
          "--input",
          "label=d",
          "--input",
          `home=${home}`,
          "--allow",
          "download",
          "--allow",
          "machine",
        ],
        { PROBE_TOKEN_PATH: tok }
      ).code,
      0
    )
    s = run(ws.root, ["status"], { PROBE_TOKEN_PATH: tok })
    assert.match(
      line(s.stdout, "probe"),
      /^ {2}probe\s+configured\s+live check unverified\s+→ dt setup probe --verify --allow machine/
    )
    // verified: ready with the receipt's date
    assert.equal(
      run(
        ws.root,
        ["setup", "probe", "--input", "label=d", "--input", `home=${home}`, "--verify", "--allow", "machine"],
        { PROBE_TOKEN_PATH: tok }
      ).code,
      0
    )
    s = run(ws.root, ["status"], { PROBE_TOKEN_PATH: tok })
    assert.match(line(s.stdout, "probe"), /^ {2}probe\s+ready · verified \d{4}-\d{2}-\d{2}\s*$/)
    // skipped, with how to come back
    assert.equal(run(ws.root, ["setup", "probe", "--skip"]).code, 0)
    s = run(ws.root, ["status"], { PROBE_TOKEN_PATH: tok })
    assert.match(line(s.stdout, "probe"), /^ {2}probe\s+skipped\s+dt setup <unit> to resume\s+→ dt setup probe/)
    // --json carries the same lines as data
    const j = JSON.parse(run(ws.root, ["status", "--json"], { PROBE_TOKEN_PATH: tok }).stdout)
    assert.equal(j.setup.find(l => l.unit === "probe").state, "skipped")
    // a skip entry no installed package provides is not silent: one line names it and how to clear it
    const pkgFile = path.join(ws.root, "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
    pkg.dreamteamer.setup = { skipped: ["probe", "ghost"] }
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
    const g = run(ws.root, ["status"], { PROBE_TOKEN_PATH: tok })
    assert.match(line(g.stdout, "ghost"), /^ {2}ghost\s+skipped\s+no installed package provides it/)
    assert.equal(
      JSON.parse(run(ws.root, ["status", "--json"], { PROBE_TOKEN_PATH: tok }).stdout).setup.find(
        l => l.unit === "ghost"
      ).state,
      "skipped"
    )
    assert.equal(j.workspace.root, fs.realpathSync(ws.root), "every JSON result names workspace.root")
    assert.equal(
      JSON.parse(run(ws.root, ["doctor", "--json"], { PROBE_TOKEN_PATH: tok }).stdout).workspace.root,
      fs.realpathSync(ws.root)
    )
  })

  test("a package with no unit reads no setup — and names its unset declared vars", () => {
    const ws = workspace({ compile: false })
    // a plain extension (no setup key) that declares an env key and a var
    const dir = path.join(ws.root, "node_modules", "plain-kit")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "plain-kit",
        version: "1.0.0",
        files: ["ext.js"],
        dreamteamer: { extension: "./ext.js", env: ["KIT_TOKEN"], vars: ["KIT_HOME"] },
      })
    )
    fs.writeFileSync(
      path.join(dir, "ext.js"),
      'export default () => ({ doctor: () => [{ label: "kit", state: "ok" }] });'
    )
    const pkgFile = path.join(ws.root, "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
    pkg.dependencies = { ...pkg.dependencies, "plain-kit": "1.0.0" }
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, "\t") + "\n")
    assert.equal(run(ws.root, ["compile"]).code, 0)
    const s = run(ws.root, ["status"])
    assert.match(
      line(s.stdout, "plain-kit"),
      /^ {2}plain-kit\s+no setup\s+needs: KIT_TOKEN, KIT_HOME\s+→ set KIT_TOKEN, KIT_HOME in \.env/
    )
    fs.writeFileSync(path.join(ws.root, ".env"), "KIT_TOKEN=x\nKIT_HOME=/k\n")
    assert.match(line(run(ws.root, ["status"]).stdout, "plain-kit"), /^ {2}plain-kit\s+no setup\s*$/)
    // its own doctor rows still render
    assert.match(run(ws.root, ["doctor"]).stdout, /plain-kit — READY\n {2}✔ kit/)
    // a plain module — collections only, no code — reads no setup too; the workspace's own module and the engine do not appear
    const plain = path.join(ws.root, "node_modules", "plain-data")
    fs.mkdirSync(path.join(plain, "collections"), { recursive: true })
    fs.writeFileSync(
      path.join(plain, "package.json"),
      JSON.stringify({
        name: "plain-data",
        version: "1.0.0",
        files: ["collections"],
        dreamteamer: { vars: ["DATA_ROOT"] },
      })
    )
    fs.writeFileSync(
      path.join(plain, "collections", "things.collection.yaml"),
      "name: things\ndescription: x\nstorage:\n  path: things\n  format: md\n  shape: file\n  suffix: thing\nids:\n  from: '{{ title | slug }}'\nfields:\n  title:\n    type: string\n"
    )
    const pkg2 = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
    pkg2.dependencies = { ...pkg2.dependencies, "plain-data": "1.0.0" }
    fs.writeFileSync(pkgFile, JSON.stringify(pkg2, null, "\t") + "\n")
    assert.equal(run(ws.root, ["compile"]).code, 0)
    const out = run(ws.root, ["status"]).stdout
    assert.match(line(out, "plain-data"), /^ {2}plain-data\s+no setup\s+needs: DATA_ROOT/)
    assert.equal(line(out, "default"), "", "the workspace module has no setup line")
    assert.equal(line(out, "dreamteamer"), "", "the engine has no setup line")
  })
})

describe("dt doctor — a unit's checks as rows, blocked is bad", () => {
  test("statuses map to ok / warn / bad and --strict fails on blocked", () => {
    const ws = probed()
    const d = run(ws.root, ["doctor"])
    assert.equal(d.code, 0, d.stderr)
    assert.match(d.stdout, /probe — DEGRADED\n(?:.*\n)*? {2}⚠ probe home {2}no folder yet — fix: dt setup probe/)
    assert.match(d.stdout, / {2}⚠ live check {2}never verified — fix: dt setup probe --verify --allow machine/)
    // a blocked check: the probe's inspect throws → one bad row, and --strict exits 1
    const b = run(ws.root, ["doctor", "--strict"], { PROBE_THROW: "inspect" })
    assert.equal(b.code, 1)
    assert.match(b.stdout, /probe — UNAVAILABLE\n {2}✖ inspect/)
  })
})

describe("dt doctor — a refused secret-path is refused as status refuses it (rnd/tests/dreamteamer/doctor-secret-path-refused)", () => {
  test(
    "a world-readable token file is a warning row with the chmod fix, never ok; owner-only is ok",
    { skip: process.platform === "win32" },
    () => {
      const ws = probed()
      const loose = path.join(ws.root, "loose-tok")
      fs.writeFileSync(loose, "x", { mode: 0o644 })
      fs.chmodSync(loose, 0o644)
      const rows = env => {
        const r = run(ws.root, ["doctor", "--json"], env)
        assert.equal(r.code, 0, r.stderr)
        return JSON.parse(r.stdout)
          .capabilities.find(c => c.name === "probe")
          .checks.filter(k => k.label === "token file")
      }
      const bad = rows({ PROBE_TOKEN_PATH: loose })
      assert.ok(bad.length >= 1, "the token file has a row")
      assert.ok(
        bad.every(k => k.state !== "ok"),
        `no token-file row reads ok: ${JSON.stringify(bad)}`
      )
      const refusal = bad.find(k => /readable by other users — chmod 600/.test(k.detail))
      assert.ok(refusal, `a row names the refusal: ${JSON.stringify(bad)}`)
      assert.equal(refusal.state, "warn")
      assert.equal(refusal.fix, "dt setup probe --input token=<path>")
      assert.match(
        run(ws.root, ["doctor"], { PROBE_TOKEN_PATH: loose }).stdout,
        /⚠ token file {2}.*readable by other users — chmod 600/
      )
      // the same verdict status gives
      const st = JSON.parse(run(ws.root, ["status", "--json"], { PROBE_TOKEN_PATH: loose }).stdout).setup.find(
        l => l.unit === "probe"
      )
      assert.ok(st.checks.some(c => /readable by other users/.test(c.detail ?? "")))
      // owner-only: the row is ok and nothing is refused
      fs.chmodSync(loose, 0o600)
      const good = rows({ PROBE_TOKEN_PATH: loose })
      assert.ok(
        good.some(k => k.state === "ok"),
        JSON.stringify(good)
      )
      assert.ok(!good.some(k => /readable by other users/.test(k.detail ?? "")))
    }
  )
})

describe("status and doctor are read-only and offline", () => {
  test("the tree hash is unchanged by either, in every state, and neither path imports a network module", () => {
    const ws = probed()
    for (const env of [{}, { PROBE_EMPTY: "1" }, { PROBE_THROW: "inspect" }]) {
      const before = treeHash(ws.root)
      run(ws.root, ["status"], env)
      run(ws.root, ["doctor"], env)
      run(ws.root, ["status", "--json"], env)
      run(ws.root, ["doctor", "--json"], env)
      assert.equal(treeHash(ws.root), before, JSON.stringify(env))
    }
    for (const f of ["src/setup.ts", "src/doctor.ts"]) {
      const text = fs.readFileSync(path.join(ENGINE_ROOT, f), "utf8")
      assert.doesNotMatch(text, /from ['"]node:(http|https|dns|net)['"]/, f)
    }
  })
})

describe("dt status — read-only even when the runtime will not load", () => {
  test("two packages claiming one unit id: status prints the refusal as its diagnosis and exits 0; doctor and setup still refuse", () => {
    const ws = workspace({ compile: false })
    withProbeSetup(ws.root)
    // a second copy of the probe under another name claims the same unit id
    const src = path.join(ws.root, "node_modules", "@probe", "setup")
    const dup = path.join(ws.root, "node_modules", "@probe", "setup-twin")
    fs.cpSync(src, dup, { recursive: true })
    const pk = JSON.parse(fs.readFileSync(path.join(dup, "package.json"), "utf8"))
    pk.name = "@probe/setup-twin"
    fs.writeFileSync(path.join(dup, "package.json"), JSON.stringify(pk))
    const pkg = JSON.parse(fs.readFileSync(path.join(ws.root, "package.json"), "utf8"))
    pkg.dependencies["@probe/setup-twin"] = "1.0.0"
    fs.writeFileSync(path.join(ws.root, "package.json"), JSON.stringify(pkg, null, "\t") + "\n")
    const s = run(ws.root, ["status"])
    assert.equal(s.code, 0, s.stderr)
    assert.match(s.stdout, /setup unit "probe" is contributed by @probe\/setup(-twin)? and @probe\/setup(-twin)?/)
    assert.match(s.stdout, /extensions did not load/)
    assert.notEqual(run(ws.root, ["setup", "probe"]).code, 0)
  })
})
