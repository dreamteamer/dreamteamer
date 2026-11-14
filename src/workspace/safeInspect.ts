import type { SetupCheck, SetupContext, SetupUnit } from "../types.ts"
import { redact } from "./redact.ts"

/** A unit's checks, never a throw: a thrown error is one blocked row, redacted; an inspect that hands back a
 *  Promise (a plain function wrapping an async body — the load-time rule only sees an AsyncFunction) is a
 *  blocked row naming the fix, never "no evidence". `dt doctor` reads through it too. */
export function safeInspect(unit: SetupUnit, ctx: SetupContext): SetupCheck[] {
  try {
    const r = unit.inspect(ctx)
    // a plain function may still hand back a Promise; its rejection is swallowed, never left unhandled
    const thenable = r as { then?: (ok: null, fail: () => void) => unknown } | null | undefined
    if (typeof thenable?.then === "function") {
      thenable.then(null, () => {})
      return [
        {
          id: `${unit.id}.inspect`,
          status: "blocked",
          title: "inspect",
          detail: "inspect returned a Promise — dt status reads it without awaiting; make it synchronous",
        },
      ]
    }
    return Array.isArray(r?.checks) ? r.checks : []
  } catch (e) {
    return [{ id: `${unit.id}.inspect`, status: "blocked", title: "inspect", detail: redact(e.message) }]
  }
}
