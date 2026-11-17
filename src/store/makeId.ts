import { DtError } from "../lib/DtError.ts"
import { slug } from "../lib/slug.ts"
import type { Collection } from "../types/Collection.ts"

/** the released engine's hash of a name that has nothing to slug */
function hash(s: string) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return "x" + h.toString(36).padStart(7, "0")
}

/** a date or date-time string is read as written, in its own zone, so an id is the same on every machine */
function formatDate(v: string, fmt: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v)
  if (!m) throw new DtError(`cannot take a date from "${v}"`)
  const parts: Record<string, string> = {
    YYYY: m[1],
    MM: m[2],
    DD: m[3],
    HH: m[4] ?? "00",
    mm: m[5] ?? "00",
    ss: m[6] ?? "00",
  }
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => parts[t])
}

/** An id from the first of the collection's templates whose fields are all given. `warnings` hears of a hash. */
export function makeId(c: Collection, data: Record<string, unknown>, warnings: string[]): string {
  for (const tpl of c.ids.from) {
    let ok = true
    function fill(_m: string, name: string, filters: string) {
      const raw = data[name]
      if (raw === undefined || raw === null || raw === "" || Array.isArray(raw)) {
        ok = false
        return ""
      }
      return filters
        .split("|")
        .map((t) => t.trim())
        .filter(Boolean)
        .reduce((v, f) => {
          const cut = f.indexOf(":")
          const fn = cut < 0 ? f : f.slice(0, cut)
          const arg = cut < 0 ? "" : f.slice(cut + 1)
          if (fn === "date") return formatDate(v, arg || "YYYY-MM-DD")
          if (fn === "basename") return v.split("/").pop()!
          if (fn === "pad") return v.padStart(Number(arg) || 0, "0")
          if (fn === "slug") {
            const s = slug(v)
            if (!s)
              warnings.push(
                `the id is a hash, not a name: "${name}" (${v}) has no Latin letters or digits to make one from — pass --id for a readable one`,
              )
            return s || hash(v)
          }
          throw new DtError(
            `${c.name}: its id rule uses the filter "${fn}", which this engine does not have — pass --id`,
          )
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a template takes a value as text
        }, String(raw))
    }
    const id = tpl.replace(/\{\{\s*(\w+)((?:\s*\|\s*\w+(?::[^|}\s]+)?)*)\s*\}\}/g, fill)
    if (ok) return id
  }
  const needs = [...new Set(c.ids.from.flatMap((t) => [...t.matchAll(/\{\{\s*(\w+)/g)].map((m) => m[1])))]
  throw new DtError(
    `${c.name}: cannot make an id — give ${needs.filter((t) => t !== "created").join(" or ")}, or pass --id`,
  )
}
