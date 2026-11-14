import { canonicalZone } from "../../record/temporal.ts"
import { DATE_ONLY, DATE_TIME } from "../../record/consts.ts"

/**
 * A temporal string → epoch ms, or null when the value isn't one (so callers can fall back).
 *
 * A date-only value resolves at UTC midnight, NOT local midnight: it names a calendar day, and
 * anchoring it to the machine's zone would make the same two records sort differently on two
 * laptops. A zoneless date-time is the one case that IS machine-local — that is what "no zone"
 * means, and the normalizer stamps an explicit offset on it before it ever reaches disk.
 */
export function parseTemporal(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null

  const d = DATE_ONLY.exec(value)
  if (d) return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))

  const m = DATE_TIME.exec(value)
  if (!m) return null
  const [, y, mo, day, h, mi, s = "0", ms = "0", zone] = m
  const z = canonicalZone(zone)
  if (!z) {
    return new Date(
      Number(y),
      Number(mo) - 1,
      Number(day),
      Number(h),
      Number(mi),
      Number(s),
      Number(ms.padEnd(3, "0"))
    ).getTime()
  }
  const t = Date.parse(`${y}-${mo}-${day}T${h}:${mi}:${s.padStart(2, "0")}.${ms.padEnd(3, "0")}${z}`)
  return Number.isNaN(t) ? null : t
}
