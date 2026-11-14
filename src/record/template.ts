import { parseTemplate } from "./parseTemplate.ts"
import type { FieldPart } from "./types.ts"
import type { TemplatePart } from "../types.ts"

export const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string | number))

// `date:HH-mm` on a date-time field is how an id embeds a start time. A date or date-time STRING
// renders as written, in its own offset (`2026-07-28T23:30:00+03:00` is 23:30 on the 28th on every
// machine), so an id is the same wherever it is generated. Only `created`/`now` read the machine's
// zone. Tokens are replaced longest-first so `MM` (month) can't eat the `M` of a minute pattern.
export const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/

export function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// non-latin titles (hebrew!) slug to "" — fall back to a short deterministic
// hash of the original value so the id stays pattern-legal and stable
export function slugOrHash(s: string): string {
  const out = slug(s)
  if (out) return out
  let h = 0
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return "x" + h.toString(36).padStart(7, "0")
}

// ---- the grammar, for compile and for display ----------------------------------------------------

export const FILTERS = ["date", "datetime", "slug", "pad", "basename"]

/** A part that names a field (a non-empty one — the test every reader here has always made). */
export const isField = (p: TemplatePart): p is FieldPart => "field" in p && !!p.field

export const templateFields = (tpl: string): string[] =>
  parseTemplate(tpl)
    .filter(isField)
    .map(p => p.field)
