// HELD-OUT (rnd/tests/dreamteamer/heldout-update-child-fails) — reviewer-written for rnd/implementation-plans/2026-11-13--dt-update-runs-the-new-version-s-setup-unit.
// dt update whose setup half fails in the fresh process (the new version's entry throws at import): exit 1 — never 0 or 3, never a crash — and the message names dt setup as the way to finish.
//
// SELF-CONTAINED FIXTURES: this file does not depend on the @fix/unit fixture the plan adds. It packs its own
// `@ho/*` packages (below) into the same offline folder buildRegistry() builds, so `--from` reads both.
//   @ho/unit 1.0.0   extension, unit `hounit`: one REQUIRED string input `calendar` (env HO_CALENDAR) — with
//                    it unset the unit needs input (exit 3); inspect names itself "hounit 1.0.0"; its env action
//                    `write-version` has no value until `calendar` is given.
//   @ho/unit 1.1.0   extension, unit `hounit`: no inputs; inspect names itself "hounit 1.1.0" (unverified, so
//                    the line reads `— hounit: configured — hounit 1.1.0 unverified`); plan: one ready env
//                    action `write-version` → HO_UNIT_VERSION=1.1.0 (declared in dreamteamer.env). Its entry
//                    THROWS AT IMPORT when HO_UNIT_CRASH=1 — the parent, holding 1.0.0 in its ESM cache, never
//                    runs that line; a fresh process does.
//   @ho/host 1.0.0   extension, unit `hohost` with a REQUIRED input `calendar` (env HO_HOST_CAL).
//   @ho/host 1.1.0   extension, unit `hohost` with no inputs ("hohost 1.1.0"), and dreamteamer.dependencies
//                    ['@ho/newdep'] — the update's closure brings a new package.
//   @ho/newdep 1.0.0 extension, unit `honewdep` ("honewdep 1.0.0", unverified, no actions).
import { test, describe, before } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { workspace, ENGINE_ROOT, git } from "../helpers/ws.js"
import { buildRegistry } from "../fixtures/registry/build.mjs"

const BIN = path.join(ENGINE_ROOT, "bin", "dreamteamer.js")
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dt-home-"))
const run = (root, args, env = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    killSignal: "SIGKILL",
    env: {
      PATH: process.env.PATH,
      HOME,
      USERPROFILE: HOME,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      ...env,
    },
  })
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}
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

const unitEntry = (id, { title, input = null, envAction = null, crashVar = null }) => `export const apiVersion = 1;
${crashVar ? `if (process.env.${crashVar} === '1') throw new Error('${title} refuses to load (${crashVar})');\n` : ""}export default function activate() {
	return { setup: [{
		id: ${JSON.stringify(id)}, version: 1,
		inputs: ${JSON.stringify(input ? [input] : [])},
		inspect: () => ({ checks: [{ id: ${JSON.stringify(`${id}.v`)}, status: 'unverified', title: ${JSON.stringify(title)}, detail: 'fixture' }] }),
		plan: (ctx, inputs = {}) => ({
			needs: ${input?.required ? `inputs.${input.id} === undefined ? [${JSON.stringify(input.id)}] : []` : "[]"},
			actions: ${envAction ? `[{ id: 'write-version', title: 'record the unit version', env: { ${envAction.key}: ${envAction.whenInput ? `inputs.${envAction.whenInput} === undefined ? undefined : ${JSON.stringify(envAction.value)}` : JSON.stringify(envAction.value)} } }]` : "[]"},
		}),
	}] };
}
`
const PACKAGES = [
  {
    name: "@ho/unit",
    version: "1.0.0",
    env: ["HO_CALENDAR", "HO_UNIT_VERSION"],
    entry: unitEntry("hounit", {
      title: "hounit 1.0.0",
      input: { id: "calendar", kind: "string", env: "HO_CALENDAR", required: true, title: "calendar" },
      envAction: { key: "HO_UNIT_VERSION", value: "1.0.0", whenInput: "calendar" },
    }),
  },
  {
    name: "@ho/unit",
    version: "1.1.0",
    env: ["HO_CALENDAR", "HO_UNIT_VERSION"],
    entry: unitEntry("hounit", {
      title: "hounit 1.1.0",
      envAction: { key: "HO_UNIT_VERSION", value: "1.1.0" },
      crashVar: "HO_UNIT_CRASH",
    }),
  },
  {
    name: "@ho/host",
    version: "1.0.0",
    env: ["HO_HOST_CAL"],
    entry: unitEntry("hohost", {
      title: "hohost 1.0.0",
      input: { id: "calendar", kind: "string", env: "HO_HOST_CAL", required: true, title: "calendar" },
    }),
  },
  {
    name: "@ho/host",
    version: "1.1.0",
    env: ["HO_HOST_CAL"],
    deps: ["@ho/newdep"],
    entry: unitEntry("hohost", { title: "hohost 1.1.0" }),
  },
  { name: "@ho/newdep", version: "1.0.0", env: [], entry: unitEntry("honewdep", { title: "honewdep 1.0.0" }) },
]
let REG
before(() => {
  REG = buildRegistry()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "dt-ho-src-"))
  for (const p of PACKAGES) {
    const dir = path.join(src, `${p.name.replace(/^@/, "").replace("/", "-")}-${p.version}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify(
        {
          name: p.name,
          version: p.version,
          description: `${p.name} ${p.version} (held-out fixture)`,
          type: "module",
          files: ["entry.js"],
          dreamteamer: {
            description: `${p.name} — a held-out fixture.`,
            extension: "./entry.js",
            env: p.env,
            ...(p.deps ? { dependencies: p.deps } : {}),
          },
        },
        null,
        "\t"
      ) + "\n"
    )
    fs.writeFileSync(path.join(dir, "entry.js"), p.entry)
    const r = spawnSync("npm", ["pack", dir, "--pack-destination", REG, "--silent"], {
      encoding: "utf8",
      timeout: 60_000,
      shell: process.platform === "win32",
    })
    if (r.status !== 0) throw new Error(`npm pack ${p.name}@${p.version} failed: ${r.stderr}`)
  }
})
const all = r => r.stdout + r.stderr

describe("held-out: the setup half failing after npm", () => {
  test('@ho/unit 1.1.0 refuses to load (HO_UNIT_CRASH=1) in the fresh process: exit 1, "dt setup" named, the 1.0.0 unit never reported as the result', () => {
    const ws = offline()
    assert.equal(run(ws.root, ["install", "@ho/unit@1.0.0", "--from", REG]).code, 3)
    // the variable reaches the setup half only through the caller's environment (processEnv → the child's env)
    const r = run(ws.root, ["update", "@ho/unit", "--from", REG], { HO_UNIT_CRASH: "1" })
    assert.equal(r.code, 1, "a setup half that could not run is a failure: " + all(r))
    assert.match(
      all(r),
      /dt (setup|install)\b/,
      "the message names how to finish (dt setup <unit>, or dt install <name>, which also commits the re-pin)"
    )
    assert.doesNotMatch(
      r.stdout,
      /hounit: configured — hounit 1\.0\.0/,
      "the stale 1.0.0 unit is never printed as this update's result"
    )
    assert.doesNotMatch(r.stdout, /needs input: calendar/)
    assert.doesNotMatch(r.stderr, /^\s+at .*update\.js/m, "the parent reports; it does not crash with a stack")
    // without the switch, finishing is exactly what the message says: a fresh dt setup runs the new unit
    const fin = run(ws.root, ["setup", "hounit"])
    assert.equal(fin.code, 0, all(fin))
    assert.match(fin.stdout, /hounit: configured — hounit 1\.1\.0 unverified/)
  })
})
