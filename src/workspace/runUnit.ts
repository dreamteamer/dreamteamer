import path from "node:path"
import fs from "node:fs"
import type { SetupAction, SetupContext, SetupInputs, SetupPlan, Workspace } from "../types.ts"
import { consent } from "./consent.ts"
import { EnvRefusal } from "./env-write.ts"
import { fingerprint } from "./fingerprint.ts"
import { gitExposure } from "./gitExposure.ts"
import { judgeEnvAction } from "./judgeEnvAction.ts"
import { leftoverTemps } from "./leftoverTemps.ts"
import { redact } from "./redact.ts"
import { safeInspect } from "./safeInspect.ts"
import { setEnvValues } from "./setEnvValues.ts"
import { isEnvAction } from "./setup-contract.ts"
import { receiptDir, unitEnv } from "./setup.ts"
import type { DrivenUnit, PendingAction, SetupIO, UnitRun } from "./types.ts"
import { writeEnvAtomic } from "./writeEnvAtomic.ts"

/** Run one unit: inspect → plan(inputs) → apply what is consented → inspect. Never throws for a
 *  provider's fault: a throwing apply is one failed action, redacted, and the unit reads blocked. */
export async function runUnit(
  ws: Workspace,
  unit: DrivenUnit,
  {
    inputs = {},
    allow = new Set(),
    tty = false,
    ask = null,
    authorize = false,
    verify = false,
    processEnv = process.env,
    api = null,
    drop = [],
    written = new Map(),
  }: {
    inputs?: SetupInputs
    allow?: Set<string>
    tty?: boolean
    ask?: SetupIO["ask"] | null
    authorize?: boolean
    verify?: boolean
    processEnv?: NodeJS.ProcessEnv
    api?: SetupContext["dt"]
    drop?: string[]
    written?: Map<string, { unit: string; value: unknown }>
  } = {}
): Promise<UnitRun> {
  // the env is re-read after every applied action: a safe action's whole point is often to write the
  // key the next inspect reads (`PROBE_HOME=` into .env), and a stale copy would report it missing.
  // `drop` names the keys whose value the engine refused (a secret-path that is missing or not
  // owner-only): the unit never sees them, so it can neither trust nor record them
  const envFor = () => {
    const e = unitEnv(ws, processEnv)
    for (const k of drop) delete e[k]
    return e
  }
  const ctx: SetupContext = { root: ws.root, ws, dt: api, env: envFor(), tty, receiptDir: receiptDir(ws, unit.id) }
  const applied: UnitRun["applied"] = [],
    failed: UnitRun["failed"] = []
  let pending: PendingAction[] = [],
    needs: string[] = []
  const done = new Set<string>(),
    refused = new Set<string>()
  // an env action is the engine's to perform (D61): judged when the plan is read against the file as
  // it was when the plan ran (the fingerprint taken before `plan`, so a plan that touches .env itself
  // makes the write refuse), then written by rename instead of handed to apply
  const envFile = path.join(ws.root, ".env")
  const envText = () => {
    try {
      return fs.readFileSync(envFile, "utf8")
    } catch {
      return ""
    }
  }
  const snapshot = (): string | Error => {
    try {
      return fingerprint(envFile)
    } catch (e) {
      return e
    }
  }
  const judge = (actions: SetupAction[], expect: string | Error): SetupAction[] =>
    actions.map(a => {
      if (!isEnvAction(a)) return a
      if (expect instanceof Error)
        return judgeEnvAction(
          { ...a, state: "blocked", reason: expect.message },
          { declared: unit.declared ?? new Set(), text: "", expect: null }
        )
      return judgeEnvAction(a, {
        declared: unit.declared ?? new Set(),
        text: envText(),
        temps: leftoverTemps(envFile),
        exposure: gitExposure(ws.root, ".env"),
        expect,
        written,
        unit: unit.id,
      })
    })
  // what is listed as pending is printed (and under --json, whole): an env action is listed by the KEYS it
  // would write, never its values; a reason is failure text, redacted (D67)
  const withReason = (a: SetupAction, extra: { why: string }): PendingAction => ({
    ...a,
    ...extra,
    ...(isEnvAction(a) ? { env: Object.keys(a.env ?? {}) } : {}),
    ...(a.reason !== undefined ? { reason: redact(a.reason) } : {}),
  })
  // the plan is asked again after every applied action: an action's preconditions are often what the
  // previous one made (a venv before the download, a key in .env before the check that reads it), so
  // one pass would leave them pending for a second call that a person should not have to make
  for (let round = 0; round < 50; round++) {
    let planned: SetupPlan
    const expect = snapshot()
    try {
      planned = (await unit.plan(ctx, inputs)) ?? {}
    } catch (e) {
      return {
        checks: safeInspect(unit, ctx),
        applied,
        pending,
        failed: [...failed, { id: "plan", message: redact(e.message) }],
        needs,
      }
    }
    needs = planned.needs ?? []
    pending = []
    let next: SetupAction | null = null
    for (const action of judge(planned.actions ?? [], expect)) {
      if (done.has(action.id)) continue
      if (action.state && action.state !== "ready") {
        if (action.state !== "done")
          pending.push(withReason(action, { why: action.state === "needs-input" ? "needs input" : action.state }))
        else done.add(action.id)
        continue
      }
      if (refused.has(action.id)) {
        pending.push(
          withReason(action, {
            why: (refused as Set<string> & { get?: (id: string) => string }).get?.(action.id) ?? "declined",
          })
        )
        continue
      }
      const isVerify = action.kind === "verify"
      if (isVerify && !verify) {
        pending.push(withReason(action, { why: "run with --verify" }))
        continue
      }
      if ((action.runBy === "owner" || (action.effects ?? []).some(e => e.kind === "account")) && !(authorize && tty)) {
        pending.push(withReason(action, { why: "the owner's step: dt setup <unit> --authorize" }))
        continue
      }
      if (!next) next = action
      else pending.push(withReason(action, { why: "after the step before it" }))
    }
    if (!next) break
    if (!(await consent(next, { allow, tty, ask, authorize }))) {
      refused.add(next.id)
      pending.push(
        withReason(next, {
          why: `needs --allow ${[...new Set((next.effects ?? []).map(e => e.kind).filter(k => k !== "workspace-files"))].join(" --allow ")}`,
        })
      )
      // the actions queued behind it stay listed as they are; nothing else can run this round
      continue
    }
    done.add(next.id)
    if (isEnvAction(next)) {
      // the engine's own write: refused only when the file moved since the plan (or cannot be written)
      try {
        const { text, changed } = setEnvValues(envText(), next.env)
        writeEnvAtomic(ws.root, text, next.expect)
        for (const k of changed) written.set(k, { unit: unit.id, value: next.env[k] })
        // a ready env action's reason is the unit's note on what it wrote or left out (a malformed row it
        // skipped); printed after the write, redacted like every reason (D67)
        applied.push({
          id: next.id,
          changed: [".env"],
          message: `wrote .env (${changed.join(", ")})${next.reason ? ` — ${redact(next.reason)}` : ""}`,
        })
        ctx.env = envFor()
      } catch (e) {
        failed.push({ id: next.id, message: e instanceof EnvRefusal ? e.message : redact(e.message) })
      }
      continue
    }
    if (typeof unit.apply !== "function") {
      failed.push({
        id: next.id,
        message: `unit ${unit.id}: action ${next.id} carries no env and the unit declares no apply`,
      })
      continue
    }
    try {
      const r = (await unit.apply(ctx, next, inputs)) ?? { ok: false, message: "apply returned nothing" }
      if (r.ok) {
        applied.push({ id: next.id, changed: r.changed ?? [], message: r.message })
        ctx.env = envFor()
      } else failed.push({ id: next.id, message: redact(r.message ?? "apply refused") })
    } catch (e) {
      failed.push({ id: next.id, message: redact(e.message) })
    }
  }
  // the final word on what is still open comes from one more plan, so a declined action and the ones
  // behind it read with their own states, never as "after the step before it"
  try {
    const expect = snapshot()
    const last = (await unit.plan(ctx, inputs)) ?? {}
    needs = last.needs ?? needs
    pending = judge(last.actions ?? [], expect)
      .filter(a => !done.has(a.id) && a.state !== "done")
      .map(a => {
        if (a.state && a.state !== "ready")
          return withReason(a, { why: a.state === "needs-input" ? "needs input" : a.state })
        if (a.kind === "verify" && !verify) return withReason(a, { why: "run with --verify" })
        if (a.runBy === "owner" || (a.effects ?? []).some(e => e.kind === "account"))
          return withReason(a, { why: "the owner's step: dt setup <unit> --authorize" })
        return withReason(a, {
          why: `needs --allow ${[...new Set((a.effects ?? []).map(e => e.kind).filter(k => k !== "workspace-files"))].join(" --allow ")}`,
        })
      })
  } catch {
    /* the loop's own view stands */
  }
  return { checks: safeInspect(unit, ctx), applied, pending, failed, needs }
}
