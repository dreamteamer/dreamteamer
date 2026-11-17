const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3})\d*)?\s*(Z|[+-]\d{2}:?\d{2})?$/i

/** a date or date-time as an instant in milliseconds, or null; a date-time with no zone is read in this machine's */
function instantOf(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null
  const d = DATE_ONLY.exec(v)
  if (d) return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))
  const m = DATE_TIME.exec(v)
  if (!m) return null
  const [, y, mo, day, h, mi, s = "0", ms = "0", zone] = m
  if (!zone) return new Date(+y, +mo - 1, +day, +h, +mi, +s, Number(ms.padEnd(3, "0"))).getTime()
  const z = /^z$/i.test(zone) ? "Z" : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone
  const t = Date.parse(`${y}-${mo}-${day}T${h}:${mi}:${s.padStart(2, "0")}.${ms.padEnd(3, "0")}${z}`)
  return Number.isNaN(t) ? null : t
}

/** the text a value compares as */
export function textOf(v: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a field value compares as its text
  return v === null || v === undefined ? "" : String(v)
}

/**
 * The released engine's ordering for range filters and `?sort=`: temporals as instants, then numbers by value (a blank
 * is never zero), then text in locale order.
 */
export function compareValues(x: unknown, y: unknown): number {
  const tx = instantOf(x)
  const ty = instantOf(y)
  if (tx !== null && ty !== null) return tx - ty
  if (x !== "" && y !== "" && x !== null && y !== null && x !== undefined && y !== undefined) {
    const nx = Number(x)
    const ny = Number(y)
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny
  }
  return textOf(x).localeCompare(textOf(y))
}
