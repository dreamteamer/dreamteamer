// Record filters as the released engine evaluates them (its `filter.js`): Directus-style operators, `_and`/`_or`,
// the `$today`/`$now` tokens, and one hop through a reference. An unknown operator or token narrows, never widens.
import { isObject } from "../lib/isObject.ts"
import { compareValues, textOf } from "../lib/compareValues.ts"

type Resolve = ((ref: string) => Record<string, unknown> | null) | undefined

/** the operators a filter may use */
export const KNOWN_OPERATORS = new Set([
  ...["_eq", "_neq", "_ieq", "_nieq", "_lt", "_lte", "_gt", "_gte", "_in", "_nin", "_null", "_nnull"],
  ...["_empty", "_nempty", "_contains", "_ncontains", "_icontains", "_starts_with", "_istarts_with"],
  ...["_ends_with", "_iends_with", "_between", "_nbetween", "_regex", "_and", "_or"],
])
const UNKNOWN = Symbol("unknown token")
const TOKEN = /^\$[A-Za-z_]\w*$/

/** equal as the released engine compares a filter's operand: by value, by text, or a number by its digits */
export function looseEq(v: unknown, o: unknown): boolean {
  return v === o || textOf(v) === textOf(o) || (typeof v === "number" && Number(o) === v)
}

/** the value a `$today` or `$now` token stands for on this machine now; undefined for a non-token */
function tokenValue(v: unknown): unknown {
  if (typeof v !== "string" || !TOKEN.test(v)) return undefined
  const at = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  if (v === "$today") return day
  if (v !== "$now") return UNKNOWN
  const mins = -at.getTimezoneOffset()
  const abs = Math.abs(mins)
  const zone = `${mins < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return `${day}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}${zone}`
}

function listOf(o: unknown): unknown[] {
  return Array.isArray(o)
    ? o
    : textOf(o)
        .split(",")
        .map((t) => t.trim())
}

function compare(op: string, v: unknown, operand: unknown): boolean {
  const o = Array.isArray(operand) ? operand.map((t: unknown) => tokenValue(t) ?? t) : (tokenValue(operand) ?? operand)
  if (o === UNKNOWN || (Array.isArray(o) && o.includes(UNKNOWN))) return false
  const s = textOf
  const none = v === null || v === undefined
  const arr = Array.isArray(v) ? v : null
  const has = (x: unknown) => (arr ? arr.includes(x) : looseEq(v, x))
  const cmp = (x: unknown) => compareValues(v, x)
  const [lo, hi] = listOf(o)
  switch (op) {
    case "_eq":
      return has(o)
    case "_neq":
      return !none && !has(o)
    case "_ieq":
      return s(v).toLowerCase() === s(o).toLowerCase()
    case "_nieq":
      return !none && s(v).toLowerCase() !== s(o).toLowerCase()
    case "_lt":
      return !none && cmp(o) < 0
    case "_lte":
      return !none && cmp(o) <= 0
    case "_gt":
      return !none && cmp(o) > 0
    case "_gte":
      return !none && cmp(o) >= 0
    case "_in":
      return listOf(o).some(has)
    case "_nin":
      return !none && !listOf(o).some(has)
    case "_null":
      return o ? none : !none
    case "_nnull":
      return o ? !none : none
    case "_empty":
    case "_nempty": {
      const empty = none || v === "" || (arr !== null && !arr.length)
      return Boolean(o) === (op === "_empty") ? empty : !empty
    }
    case "_contains":
      return arr ? arr.some((x) => s(x).includes(s(o))) : s(v).includes(s(o))
    case "_ncontains":
      return !none && !s(v).includes(s(o))
    case "_icontains":
      return (arr ?? [v]).some((x) => s(x).toLowerCase().includes(s(o).toLowerCase()))
    case "_starts_with":
      return s(v).startsWith(s(o))
    case "_istarts_with":
      return s(v).toLowerCase().startsWith(s(o).toLowerCase())
    case "_ends_with":
      return s(v).endsWith(s(o))
    case "_iends_with":
      return s(v).toLowerCase().endsWith(s(o).toLowerCase())
    case "_between":
      return !none && cmp(lo) >= 0 && cmp(hi) <= 0
    case "_nbetween":
      return !none && (cmp(lo) < 0 || cmp(hi) > 0)
    case "_regex":
      try {
        return new RegExp(s(o)).test(s(v))
      } catch {
        return false
      }
    default:
      return false
  }
}

function matchesField(value: unknown, cond: unknown, resolve: Resolve): boolean {
  if (!isObject(cond)) return compare("_eq", value, cond)
  for (const [op, operand] of Object.entries(cond)) {
    if (op.startsWith("_")) {
      if (!compare(op, value, operand)) return false
      continue
    }
    // a key that is not an operator follows the reference the field holds, one hop, and tests the record there
    if (!resolve) return false
    const refs = (Array.isArray(value) ? value : [value]).filter((t) => typeof t === "string")
    const hit = (r: string) => {
      const t = resolve(r)
      return t !== null && matchesField(t[op], operand, resolve)
    }
    if (!refs.some(hit)) return false
  }
  return true
}

/** whether a record's fields pass a filter */
export function matchesFilter(row: Record<string, unknown>, filter: unknown, resolve?: Resolve): boolean {
  if (!isObject(filter)) return true
  for (const [key, cond] of Object.entries(filter)) {
    const list = Array.isArray(cond) ? cond : []
    if (key === "_and" ? !list.every((t) => matchesFilter(row, t, resolve)) : false) return false
    if (key === "_or" ? !list.some((t) => matchesFilter(row, t, resolve)) : false) return false
    if (key !== "_and" && key !== "_or" && !matchesField(row[key], cond, resolve)) return false
  }
  return true
}

/** every operator in a filter that is not a known one */
export function unknownOperators(filter: unknown, found = new Set<string>()): Set<string> {
  if (!isObject(filter)) return found
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "_and" || key === "_or") for (const t of Array.isArray(cond) ? cond : []) unknownOperators(t, found)
    else if (key.startsWith("_")) {
      if (!KNOWN_OPERATORS.has(key)) found.add(key)
    } else unknownOperators(cond, found)
  }
  return found
}
