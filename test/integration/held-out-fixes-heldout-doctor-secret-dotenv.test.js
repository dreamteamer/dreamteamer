// HELD-OUT (rnd/tests/dreamteamer/heldout-doctor-secret-dotenv) — reviewer-written for rnd/implementation-plans/2026-11-13--dt-doctor-drops-a-refused-secret-path-as-status-does.
// A secret-path held in the workspace .env (not the process environment) is refused by dt doctor exactly as by dt status.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { workspace, withProbeSetup, ENGINE_ROOT, git } from "../helpers/ws.js"

const BIN = path.join(ENGINE_ROOT, "bin", "dreamteamer.js")
const POSIX = process.platform !== "win32"
// the same runner status-setup.test.js uses: a private HOME under the workspace, nothing else from the caller's env
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
      USERPROFILE: home,
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
const tokenFile = (file, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "x")
  fs.chmodSync(file, mode)
  return file
}
/** The probe capability of `dt doctor --json`. */
const doctorProbe = (root, env = {}, extra = []) => {
  const d = run(root, ["doctor", "--json", ...extra], env)
  assert.equal(d.code, 0, d.stderr)
  const cap = JSON.parse(d.stdout).capabilities.find(c => c.name === "probe")
  assert.ok(cap, `no probe capability in ${d.stdout}`)
  return cap
}
/** The probe line of `dt status --json`'s setup section. */
const statusProbe = (root, env = {}) => {
  const s = run(root, ["status", "--json"], env)
  assert.equal(s.code, 0, s.stderr)
  const l = JSON.parse(s.stdout).setup.find(x => x.unit === "probe")
  assert.ok(l, `no probe line in ${s.stdout}`)
  return l
}
const refusedRow = (rows, re) => rows.find(r => re.test(String(r.detail ?? "")))

describe("held-out: dt doctor refuses a secret-path that .env holds", () => {
  test(
    "PROBE_TOKEN_PATH in .env at 0644: doctor shows the refused row as a warning with the chmod text and the fix; the unit never sees the key; 0600 is ok",
    { skip: !POSIX && "no mode check on win32" },
    () => {
      const ws = probed()
      const loose = tokenFile(path.join(ws.root, "secrets", "tok"), 0o644)
      fs.writeFileSync(path.join(ws.root, ".env"), `PROBE_TOKEN_PATH=${loose}\n`)
      // the process environment carries no PROBE_TOKEN_PATH: only .env does
      const text = run(ws.root, ["doctor"])
      assert.equal(text.code, 0, text.stderr)
      assert.match(text.stdout, /probe — DEGRADED/)
      assert.match(
        text.stdout,
        / {2}⚠ token file {2}.*tok is readable by other users — chmod 600 .*tok — fix: dt setup probe --input token=/
      )
      const cap = doctorProbe(ws.root)
      const row = refusedRow(cap.checks, /readable by other users — chmod 600/)
      assert.ok(row, `no refused row in ${JSON.stringify(cap.checks)}`)
      assert.equal(row.state, "warn")
      assert.match(String(row.fix), /^dt setup probe --input token=/)
      // the value was dropped before inspect: the probe's own token row says the key is unset, never "present"
      assert.ok(
        cap.checks.some(c => /PROBE_TOKEN_PATH is unset/.test(String(c.detail))),
        JSON.stringify(cap.checks)
      )
      assert.ok(!cap.checks.some(c => /present \(never read\)/.test(String(c.detail))), JSON.stringify(cap.checks))
      // status says the same thing about the same file
      assert.ok(refusedRow(statusProbe(ws.root).checks, /readable by other users — chmod 600/))
      // owner-only: no refused row, and the unit sees the file
      fs.chmodSync(loose, 0o600)
      const ok = doctorProbe(ws.root)
      assert.equal(refusedRow(ok.checks, /readable by other users/), undefined, JSON.stringify(ok.checks))
      const tokenRow = ok.checks.find(c => /present \(never read\)/.test(String(c.detail)))
      assert.ok(tokenRow, JSON.stringify(ok.checks))
      assert.equal(tokenRow.state, "ok")
    }
  )
})
