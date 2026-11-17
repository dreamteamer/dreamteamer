import type { Field } from "../types/Field.ts"
import { SCALARS } from "../model/SCALARS.ts"
import type { Model } from "../types/Model.ts"
import { refExists } from "./refExists.ts"

const TEXT = new Set(["string", "markdown", "url", "email", "position"])
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[Tt\s]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?([Zz]|[+-]\d{2}(:?\d{2})?)$/
const DECIMAL = /^-?\d+(\.\d+)?$/

function realDate(y: string, m: string, d: string) {
  const t = new Date(Date.UTC(+y, +m - 1, +d))
  return t.getUTCFullYear() === +y && t.getUTCMonth() === +m - 1 && t.getUTCDate() === +d
}

/**
 * What is wrong with one value of a field, or null. `unresolved` counts references into declared peers that are not
 * installed; a `plain` reference is checked as text.
 */
export function checkValue(
  model: Model,
  f: Field,
  v: unknown,
  unresolved?: Map<string, number>,
  plain = false,
): string | null {
  const ref = typeof f.type !== "string" || !SCALARS.has(f.type) || f.type === "reference"
  const type = plain && ref ? "string" : typeof f.type === "string" ? f.type : "ref"
  if (TEXT.has(type)) {
    if (typeof v === "object") return "expected text"
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a scalar is checked as text
    const s = String(v)
    if (type === "url" && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/.test(s))
      return "expected a URL with a scheme, such as https://…"
    if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "expected an email address"
    if (f.minLength !== undefined && s.length < f.minLength) return `shorter than ${f.minLength} characters`
    if (f.maxLength !== undefined && s.length > f.maxLength) return `longer than ${f.maxLength} characters`
  } else if (type === "boolean") {
    if (typeof v !== "boolean" && v !== "true" && v !== "false") return "expected true or false"
  } else if (type === "integer" || type === "number") {
    const n = typeof v === "string" && DECIMAL.test(v) ? Number(v) : v
    if (typeof n !== "number" || !Number.isFinite(n) || (type === "integer" && !Number.isInteger(n)))
      return type === "integer" ? "expected an integer" : "expected a number"
    if (f.minimum !== undefined && n < f.minimum) return `less than the minimum ${f.minimum}`
    if (f.maximum !== undefined && n > f.maximum) return `more than the maximum ${f.maximum}`
  } else if (type === "date") {
    const m = DATE.exec(String(v))
    if (!m || !realDate(m[1], m[2], m[3])) return "expected a real date, YYYY-MM-DD"
  } else if (type === "datetime") {
    const m = DATETIME.exec(String(v))
    if (!m || !realDate(m[1], m[2], m[3]))
      return "expected a date and time with a zone, such as 2026-12-01T10:00:00+02:00"
  } else if (type === "object" || type === "map") {
    if (typeof v !== "object" || v === null) return "expected a map"
  } else {
    if (typeof v !== "string") return "expected a <collection>/<id> reference"
    if (f.type === "reference") {
      if (!f.soft && !refExists(model, v)) return `broken reference ${v}`
    } else {
      const target = [f.type]
        .flat()
        .sort((a, b) => b.length - a.length)
        .find((t) => v.startsWith(t + "/"))
      if (!target) return `expected a ${[f.type].flat().join(" | ")}/<id> reference`
      if (!model.collections[target]) unresolved?.set(target, (unresolved.get(target) ?? 0) + 1)
      else if (!f.soft && !refExists(model, v)) return `broken reference ${v}`
    }
  }
  if (f.enum && !f.enum.some((t) => t === v || String(t) === String(v))) return `not one of ${f.enum.join(" | ")}`
  if (f.pattern && typeof v === "string" && !new RegExp(f.pattern).test(v)) return `does not match ${f.pattern}`
  return null
}
