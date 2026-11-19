import { canonicalZone } from "../../record/temporal.ts"
import { DATE_ONLY, DATE_TIME } from "../../record/consts.ts"

/** `+03:00` for the machine's local offset AT that wall clock — DST-correct, unlike a bare "now" offset. */
function localOffsetAt(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  const mins = -new Date(y, mo - 1, d, h, mi, s).getTimezoneOffset()
  const sign = mins < 0 ? "-" : "+"
  const abs = Math.abs(mins)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}

/**
 * Coerce one value to the canonical spelling for its declared `format`. Anything unrecognized is
 * returned untouched — ajv rejects it a moment later with a better message than we could write.
 *
 * `date-time`: seconds are filled in, the zone is canonicalized, and a MISSING zone becomes the
 * machine's local offset at that wall clock. `date`: a date-time is truncated to the calendar day
 * AS WRITTEN — the day in the value's own offset, not in UTC and not in the reader's zone, because
 * "2026-07-28T23:00+03:00" is a meeting on the 28th to everyone who cares about it.
 */
export function normalizeTemporal<T>(value: T, format: string | undefined): T | string {
  if (typeof value !== "string" || value === "") return value

  if (format === "date") {
    const m = DATE_TIME.exec(value)
    return m ? `${m[1]}-${m[2]}-${m[3]}` : value
  }

  if (format !== "date-time") return value

  const d = DATE_ONLY.exec(value)
  if (d) return `${value}T00:00:00${localOffsetAt(Number(d[1]), Number(d[2]), Number(d[3]), 0, 0, 0)}`

  const m = DATE_TIME.exec(value)
  if (!m) return value
  const [, y, mo, day, h, mi, s = "00", , zone] = m
  const sec = String(s).padStart(2, "0")
  const z = canonicalZone(zone) ?? localOffsetAt(Number(y), Number(mo), Number(day), Number(h), Number(mi), Number(sec))
  return `${y}-${mo}-${day}T${h}:${mi}:${sec}${z}`
}
