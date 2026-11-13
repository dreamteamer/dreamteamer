// @probe/setup — the engine's own test double for the setup contract. It is what every unit the
// engine ever drives looks like from the engine's side: inputs of every kind, checks in every status,
// actions carrying every effect kind, a receipt-writing verify, and switches that make it misbehave.
//   PROBE_THROW=apply   apply() throws (with a secret in the message, which must be redacted)
//   PROBE_THROW=inspect inspect() throws (one bad doctor row, a blocked status line)
//   PROBE_BLOCK=1   the download is blocked, with a reason the line must carry
//   PROBE_EMPTY=1       inspect() returns zero checks (the "no evidence" line)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

export const apiVersion = 1

const expand = p => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p)
const exists = p => {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}
const sha = text => createHash("sha256").update(text).digest("hex").slice(0, 16)

/** The probe's home: the filled input first, else the environment the engine handed over, else the default. */
const homeOf = (ctx, inputs = {}) => expand(inputs.home ?? ctx.env?.PROBE_HOME ?? "~/.cache/probe")
const envFile = ctx => path.join(ctx.root, ".env")
const readEnv = ctx => (exists(envFile(ctx)) ? fs.readFileSync(envFile(ctx), "utf8") : "")
const receiptFile = ctx => path.join(ctx.receiptDir, "verify.json")

function inspect(ctx) {
  if (ctx.env?.PROBE_THROW === "inspect") throw new Error("probe inspect exploded: secret=hunter2")
  if (ctx.env?.PROBE_EMPTY) return { checks: [] }
  const home = homeOf(ctx)
  const token = ctx.env?.PROBE_TOKEN_PATH
  const receipt = exists(receiptFile(ctx)) ? JSON.parse(fs.readFileSync(receiptFile(ctx), "utf8")) : null
  const row = (id, ok, title, detail, fix) => ({ id, status: ok ? "configured" : "missing", title, detail, fix })
  return {
    checks: [
      row(
        "probe.home",
        exists(home),
        "probe home",
        exists(home) ? "the folder exists" : "no folder yet",
        "dt setup probe"
      ),
      row(
        "probe.token",
        !!token && exists(expand(token)),
        "token file",
        token
          ? exists(expand(token))
            ? "present (never read)"
            : "the configured path does not exist"
          : "PROBE_TOKEN_PATH is unset",
        "set PROBE_TOKEN_PATH"
      ),
      row(
        "probe.weights",
        exists(path.join(home, "weights.txt")),
        "weights",
        "downloaded weights",
        "dt setup probe --allow download"
      ),
      row("probe.tuned", exists(path.join(home, "tuned")), "tuned", "machine tuning", "dt setup probe --allow machine"),
      {
        id: "probe.live",
        status: receipt ? "ready" : "unverified",
        title: "live check",
        detail: receipt ? `verified ${receipt.at}` : "never verified",
        fix: "dt setup probe --verify --allow machine",
        evidence: receipt ? { at: receipt.at } : undefined,
      },
    ],
  }
}

function plan(ctx, inputs = {}) {
  const { checks } = inspect(ctx)
  const home = homeOf(ctx, inputs)
  const status = Object.fromEntries(checks.map(c => [c.id, c.status]))
  const envText = readEnv(ctx)
  const needs = inputs.label === undefined ? ["label"] : []
  const wantEnv = {
    PROBE_HOME: inputs.home ?? ctx.env?.PROBE_HOME ?? "~/.cache/probe",
    PROBE_LABEL: inputs.label ?? "",
  }
  const envDone = Object.entries(wantEnv).every(([k, v]) =>
    new RegExp(`^${k}=${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(envText)
  )
  const actions = [
    {
      id: "make-home",
      title: "write PROBE_HOME and PROBE_LABEL into .env",
      effects: [{ kind: "workspace-files", detail: ".env: PROBE_HOME and PROBE_LABEL only, other keys kept" }],
      preview: { file: ".env", set: wantEnv },
      expect: sha(envText),
      runBy: "engine",
      state: envDone ? "done" : needs.length ? "needs-input" : "ready",
    },
    {
      id: "fetch",
      title: "download the weights",
      effects: [{ kind: "download", detail: `${home}/weights.txt (synthetic, 12 bytes)` }],
      runBy: "engine",
      ...(ctx.env?.PROBE_BLOCK
        ? { state: "blocked", reason: "the weights server is down (simulated)" }
        : { state: status["probe.weights"] === "configured" ? "done" : "ready" }),
    },
    {
      id: "tune",
      title: "tune the machine",
      effects: [{ kind: "machine", detail: `${home}/tuned` }],
      runBy: "engine",
      state: status["probe.tuned"] === "configured" ? "done" : "ready",
    },
    {
      id: "sign-in",
      title: "sign in to the probe account",
      effects: [{ kind: "account", detail: "opens a browser (simulated)" }],
      runBy: "owner",
      state: "ready",
    },
    {
      id: "verify",
      title: "run the live check",
      kind: "verify",
      effects: [{ kind: "machine", detail: "runs the probe once and writes the receipt" }],
      runBy: "engine",
      state: status["probe.live"] === "ready" ? "done" : "ready",
    },
  ]
  return { checks, actions, needs }
}

function apply(ctx, action, inputs = {}) {
  if (ctx.env?.PROBE_THROW === "apply") throw new Error("probe exploded: token=hunter2 at " + homeOf(ctx, inputs))
  const home = homeOf(ctx, inputs)
  switch (action.id) {
    case "make-home": {
      const text = readEnv(ctx)
      if (sha(text) !== action.expect)
        return { ok: false, changed: [], message: ".env changed since the plan — plan again" }
      let out = text
      for (const [k, v] of Object.entries(action.preview.set)) {
        const re = new RegExp(`^${k}=.*$`, "m")
        out = re.test(out) ? out.replace(re, `${k}=${v}`) : `${out}${out && !out.endsWith("\n") ? "\n" : ""}${k}=${v}\n`
      }
      fs.writeFileSync(envFile(ctx), out)
      fs.mkdirSync(home, { recursive: true })
      return { ok: true, changed: [".env"], message: "wrote .env" }
    }
    case "fetch":
      fs.mkdirSync(home, { recursive: true })
      fs.writeFileSync(path.join(home, "weights.txt"), "synthetic\n")
      return { ok: true, changed: [path.join(home, "weights.txt")] }
    case "tune":
      fs.mkdirSync(home, { recursive: true })
      fs.writeFileSync(path.join(home, "tuned"), "")
      return { ok: true, changed: [path.join(home, "tuned")] }
    case "sign-in":
      return { ok: true, changed: [], message: "signed in (simulated)" }
    case "verify": {
      fs.mkdirSync(ctx.receiptDir, { recursive: true })
      const receipt = { what: "probe ran once", at: new Date().toISOString().slice(0, 10), home }
      fs.writeFileSync(receiptFile(ctx), JSON.stringify(receipt, null, 2) + "\n")
      return { ok: true, changed: [receiptFile(ctx)], message: "receipt written" }
    }
    default:
      return { ok: false, changed: [], message: `unknown action ${action.id}` }
  }
}

export default function activate() {
  return {
    setup: [
      {
        id: "probe",
        version: 1,
        inputs: [
          {
            id: "home",
            kind: "path",
            env: "PROBE_HOME",
            title: "probe home",
            default: "~/.cache/probe",
            prompt: "Where should probe keep its files?",
          },
          { id: "label", kind: "string", required: true, title: "label", prompt: "A label for this workspace" },
          {
            id: "token",
            kind: "secret-path",
            env: "PROBE_TOKEN_PATH",
            title: "token file",
            prompt: "Path to the probe token file (never read)",
          },
          { id: "rows", kind: "rows", title: "rows", rows: { columns: ["name", "value"] } },
        ],
        inspect,
        plan,
        apply,
      },
    ],
  }
}
