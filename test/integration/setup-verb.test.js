// `dt setup` through the real binary, against the synthetic provider: inputs, consent per effect,
// apply, receipt, skip, exit codes — every state of the design's status table reached and asserted.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { workspace, withProbeSetup, ENGINE_ROOT, readFile, git } from "../helpers/ws.js"

const BIN = path.join(ENGINE_ROOT, "bin", "dreamteamer.js")
/** The CLI with a controlled environment: no TTY (stdio piped), HOME in the fixture, PROBE_* as given. */
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
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", home }
}
const probed = () => {
  const ws = workspace({ compile: false })
  withProbeSetup(ws.root)
  git(ws.root, ["add", "-A"])
  git(ws.root, ["commit", "-qm", "fixture: probe"])
  return ws
}

describe("dt setup probe — the synthetic unit through every state", () => {
  test("inputs given: the safe action runs, consequential ones are pending, exit 0", () => {
    const ws = probed()
    const r = run(ws.root, ["setup", "probe", "--input", "label=demo"])
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /— probe: configured/)
    assert.match(r.stdout, /✔ make-home — wrote \.env/)
    assert.match(r.stdout, /… fetch \(needs --allow download\)/)
    assert.match(r.stdout, /… tune \(needs --allow machine\)/)
    assert.match(r.stdout, /… sign-in \(the owner's step: dt setup <unit> --authorize\)/)
    assert.match(r.stdout, /… verify \(run with --verify\)/)
    // a path input is expanded by the engine before the unit sees it, so .env carries the real path
    assert.equal(readFile(ws.root, ".env").split("\n")[0], `PROBE_HOME=${path.join(r.home, ".cache", "probe")}`)
    assert.match(readFile(ws.root, ".env"), /^PROBE_LABEL=demo$/m)
    // the home came from the default, expanded under the fixture's HOME
    assert.ok(fs.existsSync(path.join(r.home, ".cache", "probe")), "default home created")
    // a second identical run applies nothing and changes nothing
    const before = readFile(ws.root, ".env")
    const again = run(ws.root, ["setup", "probe", "--input", "label=demo"])
    assert.equal(again.code, 0)
    assert.doesNotMatch(again.stdout, /✔ make-home/)
    assert.equal(readFile(ws.root, ".env"), before)
  })

  test("--allow per effect applies download and machine; --verify writes the receipt and the line reads ready · verified", () => {
    const ws = probed()
    // the token file is an optional secret-path input read from the environment; present, never opened
    const tok = path.join(ws.root, "tok")
    fs.writeFileSync(tok, "secret", { mode: 0o600 })
    fs.chmodSync(tok, 0o600) // a secret-path the unit may see is owner-only
    const withTok = { PROBE_TOKEN_PATH: tok }
    const r = run(
      ws.root,
      [
        "setup",
        "probe",
        "--input",
        "label=demo",
        "--input",
        "home=" + path.join(ws.root, "phome"),
        "--allow",
        "download",
        "--allow",
        "machine",
      ],
      withTok
    )
    assert.equal(r.code, 0, r.stderr)
    assert.ok(fs.existsSync(path.join(ws.root, "phome", "weights.txt")))
    assert.ok(fs.existsSync(path.join(ws.root, "phome", "tuned")))
    assert.match(r.stdout, /— probe: configured — live check unverified/)
    const v = run(
      ws.root,
      [
        "setup",
        "probe",
        "--input",
        "label=demo",
        "--input",
        "home=" + path.join(ws.root, "phome"),
        "--verify",
        "--allow",
        "machine",
      ],
      withTok
    )
    assert.equal(v.code, 0, v.stderr)
    assert.match(v.stdout, /✔ probe: ready · verified \d{4}-\d{2}-\d{2}/)
    assert.ok(fs.existsSync(path.join(ws.root, ".dreamteamer", "setup", "probe", "verify.json")))
    // the receipt lives with the runtime: gitignored, never committed
    assert.equal(git(ws.root, ["status", "--porcelain", "--", ".dreamteamer"]), "")
    // a verify without its machine consent stays pending
    fs.rmSync(path.join(ws.root, ".dreamteamer", "setup"), { recursive: true })
    const w = run(
      ws.root,
      ["setup", "probe", "--input", "label=demo", "--input", "home=" + path.join(ws.root, "phome"), "--verify"],
      withTok
    )
    assert.match(w.stdout, /… verify \(needs --allow machine\)/)
  })

  test("two rows for a rows input in one call are both taken (US-006-3), exit 0", () => {
    const ws = probed()
    const r = run(ws.root, [
      "setup",
      "probe",
      "--input",
      "label=demo",
      "--input",
      "rows=a|1",
      "--input",
      "rows=b|2",
      "--no-input",
      "--json",
    ])
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.doesNotMatch(r.stderr, /different values/)
  })

  test("a unit with the owner's step pending prints the command that runs it, --authorize included (hm7)", () => {
    const ws = probed()
    const r = run(ws.root, ["setup", "probe", "--input", "label=demo", "--no-input"])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /the owner's step \(opens a browser\): dt setup probe --authorize/)
  })

  test("a blocked action carries the module's reason on the text line, not only in --json", () => {
    const ws = probed()
    const r = run(ws.root, ["setup", "probe", "--input", "label=demo", "--no-input"], { PROBE_BLOCK: "1" })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /… fetch \(blocked\) — the weights server is down \(simulated\)/)
  })

  test("--authorize takes one unit: with none named it is a usage refusal, exit 2, before the terminal is asked for", () => {
    const ws = probed()
    const r = run(ws.root, ["setup", "--authorize"])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /--authorize takes one unit: dt setup <unit> --authorize/)
  })

  test(
    "a secret-path input must exist and be owner-only: a missing file and a world-readable one are refused naming the path, before any unit runs",
    { skip: process.platform === "win32" },
    () => {
      const ws = probed()
      const missing = run(ws.root, [
        "setup",
        "probe",
        "--input",
        "label=demo",
        "--input",
        `token=${path.join(ws.root, "no-such-token")}`,
        "--no-input",
      ])
      assert.equal(missing.code, 2, missing.stdout)
      assert.match(missing.stderr, /--input token=.*no-such-token: no such file/)
      const tok = path.join(ws.root, "..", `tok-${path.basename(ws.root)}`)
      fs.writeFileSync(tok, "x", { mode: 0o644 })
      fs.chmodSync(tok, 0o644)
      const open = run(ws.root, ["setup", "probe", "--input", "label=demo", "--input", `token=${tok}`, "--no-input"])
      assert.equal(open.code, 2, open.stdout)
      assert.match(open.stderr, /readable by other users — chmod 600/)
      assert.ok(!fs.existsSync(path.join(ws.root, ".env")), "nothing ran")
      fs.chmodSync(tok, 0o600)
      const ok = run(ws.root, ["setup", "probe", "--input", "label=demo", "--input", `token=${tok}`, "--no-input"])
      assert.equal(ok.code, 0, ok.stderr + ok.stdout)
      fs.rmSync(tok, { force: true })
    }
  )

  test(
    "an optional secret-path the environment holds at 0644 is reported on the line and left unfilled — exit 0, nothing crashes",
    { skip: process.platform === "win32" },
    () => {
      const ws = probed()
      const tok = path.join(ws.root, "..", `envtok-${path.basename(ws.root)}`)
      fs.writeFileSync(tok, "x", { mode: 0o644 })
      fs.chmodSync(tok, 0o644)
      const r = run(ws.root, ["setup", "probe", "--input", "label=demo", "--no-input"], { PROBE_TOKEN_PATH: tok })
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stdout, /✖ token — .*readable by other users — chmod 600/)
      assert.doesNotMatch(r.stdout, /needs input: token/)
      // the unit never sees the refused value: its own token row reads unset, not 'present'
      const j = run(ws.root, ["setup", "probe", "--input", "label=demo", "--json"], { PROBE_TOKEN_PATH: tok })
      assert.match(JSON.parse(j.stdout).units[0].checks.find(c => c.id === "probe.token").detail, /unset/)
      fs.rmSync(tok, { force: true })
    }
  )

  test("--authorize without a terminal is a usage refusal, exit 2", () => {
    const ws = probed()
    const r = run(ws.root, ["setup", "probe", "--authorize"])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /--authorize needs a terminal/)
  })

  test("--skip records the skip in package.json and commits it; the line reads skipped; running setup again clears it", () => {
    const ws = probed()
    const r = run(ws.root, ["setup", "probe", "--skip"])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(readFile(ws.root, "package.json")).dreamteamer.setup, { skipped: ["probe"] })
    assert.match(git(ws.root, ["log", "-1", "--pretty=%s"]), /dreamteamer: skip setup of probe/)
    assert.equal(git(ws.root, ["status", "--porcelain"]), "")
    const s = run(ws.root, ["setup", "--no-input"])
    assert.match(s.stdout, /— probe: skipped/)
    // the skip is a known manifest key: compile, status and install keep working with it in package.json
    const c = run(ws.root, ["compile"])
    assert.equal(c.code, 0, c.stderr + c.stdout)
    assert.equal(run(ws.root, ["status"]).code, 0)
    const back = run(ws.root, ["setup", "probe", "--input", "label=x", "--no-input"])
    assert.match(back.stdout, /✔ probe: no longer skipped/)
    assert.equal(JSON.parse(readFile(ws.root, "package.json")).dreamteamer.setup, undefined)
  })

  test("a required input with no value and no TTY: exit 3, JSON names it, home still filled from its default", () => {
    const ws = probed()
    const r = run(ws.root, ["setup", "probe", "--json"])
    assert.equal(r.code, 3, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.workspace.root, ws.root)
    assert.deepEqual(out.units[0].needs, ["label"])
    assert.equal(out.units[0].state, "configured")
    // make-home needs the label, so it is pending, not applied
    assert.deepEqual(out.units[0].applied, [])
    assert.ok(out.units[0].pending.some(p => p.id === "make-home" && p.why === "needs input"))
  })

  test("a provider that throws in apply: the unit reads blocked with the error redacted, exit 1 (D57: a failed apply is a failure)", () => {
    const ws = probed()
    const r = run(ws.root, ["setup", "probe", "--input", "label=demo"], { PROBE_THROW: "apply" })
    assert.equal(r.code, 1, r.stderr)
    assert.match(r.stdout, /✖ probe: blocked/)
    assert.match(r.stdout, /✖ make-home — probe exploded: token=\[redacted\]/)
    assert.doesNotMatch(r.stdout, /hunter2/)
  })

  test("zero checks is no evidence; an unknown unit, a bad --allow and a bad --input are usage refusals", () => {
    const ws = probed()
    const e = run(ws.root, ["setup", "probe", "--input", "label=demo", "--json"], { PROBE_EMPTY: "1" })
    assert.equal(JSON.parse(e.stdout).units[0].state, "no-evidence")
    assert.equal(run(ws.root, ["setup", "nope"]).code, 2)
    assert.match(run(ws.root, ["setup", "nope"]).stderr, /no setup unit "nope" — installed units: probe/)
    assert.match(
      run(ws.root, ["setup", "probe", "--allow", "account"]).stderr,
      /--allow takes one of download, network, machine/
    )
    assert.match(run(ws.root, ["setup", "probe", "--input", "nope=1"]).stderr, /--input nope= names no input of probe/)
  })
})
