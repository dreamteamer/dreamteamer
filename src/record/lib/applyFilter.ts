import { fmtDate } from "./fmtDate.ts"
import { asDate, slug, slugOrHash } from "../template.ts"
import { FILTERS } from "../consts.ts"
import type { OnFallback } from "./types.ts"

export function applyFilter(
  name: string,
  arg: string | undefined,
  value: unknown,
  ctx: { field?: string; onFallback?: OnFallback } = {}
): string {
  switch (name) {
    case "date":
      return fmtDate(value, arg || "YYYY-MM-DD")
    // ids are paths: no colons (windows-hostile, ungreppable) — 2026-07-25T13-39-17
    case "datetime":
      return asDate(value).toISOString().slice(0, 19).replace(/:/g, "-")
    // ⚠ THE SILENCE IS THE DEFECT, NOT THE ERGONOMICS. A value with no a-z0-9 in it — any Hebrew,
    // Arabic, Cyrillic or CJK name — has nothing to slug, so this falls back to a deterministic
    // hash and THE WRITE SUCCEEDS. That is worse than a refusal: `x1a2b3c4` lands, passes
    // `check`, gets referenced by other records, and is discovered only when a person reads the
    // tree, by which point renaming it is a migration. The fallback still happens (an id must be
    // produced, and existing records keep theirs), but it is no longer silent: the caller is
    // handed the field, the value and the id so a writer can say so.
    case "slug": {
      const out = slugOrHash(String(value))
      if (ctx.onFallback && out !== slug(String(value))) {
        ctx.onFallback({ field: ctx.field, value: String(value), id: out })
      }
      return out
    }
    case "pad":
      return String(value).padStart(Number(arg) || 0, "0")
    case "basename":
      return String(value).split("/").pop()
    default:
      throw new Error(`unknown template filter "${name}" — the filters are ${FILTERS.join(" · ")}`)
  }
}
