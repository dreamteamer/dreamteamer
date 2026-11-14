import type { SetupAction } from "../types.ts"
import { EnvRefusal } from "./env-write.ts"
import { redact } from "./redact.ts"
import { setEnvValues } from "./setEnvValues.ts"
import { isEnvAction } from "./setup-contract.ts"
import { validateEnvAction } from "./validateEnvAction.ts"

/**
 * Judge an env action when a plan is read — the driver's own verdict, from what it can see without
 * writing (D61). Pure: handed the `.env` text, the leftover temps beside it, the git exposure verdict
 * and the plan-time fingerprint (`expect`). Returns the action as the driver will treat it: `done`
 * when every key already holds its value; `needs-input` for a value not yet known; `blocked` with the
 * reason for anything the write would refuse; else the unit's own state (`ready` by default) with
 * `expect` stamped and `effects` defaulted to the one workspace-files entry. A plain action is
 * returned as is.
 */
export function judgeEnvAction(
  action: SetupAction,
  {
    declared,
    text,
    temps = [],
    exposure = { safe: true },
    expect,
    written = new Map(),
    unit = null,
  }: {
    declared?: Set<string>
    text: string
    temps?: string[]
    exposure?: { safe: boolean; reason?: string }
    expect?: string | null
    written?: Map<string, { unit: string; value: unknown }>
    unit?: string | null
  }
): SetupAction {
  if (!isEnvAction(action)) return action
  const keys = Object.keys(action.env ?? {})
  const effects = (action.effects ?? []).length
    ? action.effects
    : [{ kind: "workspace-files", detail: `.env: ${keys.join(", ")}` }]
  const out = { ...action, effects, runBy: action.runBy ?? "engine" }
  const v = validateEnvAction(action, declared)
  if (v.ok === false) return { ...out, state: v.state, reason: v.reason }
  let changed: string[]
  try {
    ;({ changed } = setEnvValues(text, action.env))
  } catch (e) {
    return { ...out, state: "blocked", reason: e instanceof EnvRefusal ? e.message : redact(e.message) }
  }
  if (!changed.length)
    return {
      ...out,
      state: "done",
      reason: `${keys.join(", ")} already hold${keys.length === 1 ? "s" : ""} this value`,
    }
  // two units sharing a key is allowed (one input, D39); two units writing DIFFERENT values to it in one run
  // is not — the last write would win silently and the first unit would read a value it never wrote (he3)
  const clash = changed.find(
    k => written.has(k) && written.get(k).unit !== unit && written.get(k).value !== action.env[k]
  )
  if (clash)
    return {
      ...out,
      state: "blocked",
      reason: `${clash} was written by unit ${written.get(clash).unit} in this run with another value — two units disagree on it; set it by hand`,
    }
  if (temps.length)
    return {
      ...out,
      state: "blocked",
      reason: `temporary files from an interrupted write sit beside .env (${temps.join(", ")}) — review and delete them first`,
    }
  if (!exposure.safe) return { ...out, state: "blocked", reason: exposure.reason }
  if (action.state && action.state !== "ready" && action.state !== "done") return { ...out, expect }
  return { ...out, state: "ready", expect }
}
