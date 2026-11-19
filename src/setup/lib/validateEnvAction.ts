import type { SetupAction } from "../../types.ts"
import { ENV_KEY } from "../consts.ts"

/**
 * Judge an env action's shape when a plan is read. `declared` is the Set of env keys the package
 * declares (`dreamteamer.env` ∪ `vars`). `{ ok: true }`, or `{ ok: false, state, reason }` where
 * `state` is what the driver writes on the action: `needs-input` for a value not yet known
 * (`undefined`/`null` — the shape a unit's plan has before its input arrives), `blocked` for anything
 * the unit got wrong. Pure; the file-level refusals (git exposure, a key assigned twice, a quote in
 * the value) are `src/env-write.js`'s, judged by the driver with the file in hand.
 */
export function validateEnvAction(
  action: SetupAction | null | undefined,
  declared: Set<string>
): { ok: true } | { ok: false; state: "needs-input" | "blocked"; reason: string } {
  const env = action?.env
  if (!env || typeof env !== "object" || Array.isArray(env))
    return { ok: false, state: "blocked", reason: "env must be an object of KEY → value" }
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key)) return { ok: false, state: "blocked", reason: `${key} is not an environment key` }
    if (!declared.has(key))
      return { ok: false, state: "blocked", reason: `${key} is not declared by the package (dreamteamer.env or vars)` }
    if (value === undefined || value === null)
      return { ok: false, state: "needs-input", reason: `${key} has no value yet` }
    if (typeof value !== "string")
      return { ok: false, state: "blocked", reason: `${key}: a value that is not a string` }
  }
  return { ok: true }
}
