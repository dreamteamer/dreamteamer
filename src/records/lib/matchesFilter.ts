import { UNKNOWN_TOKEN } from "./consts.ts"
import { compareValues } from "./compareValues.ts"
import { looseEq } from "./looseEq.ts"
import { tokenValue } from "./tokenValue.ts"
import { KNOWN_OPERATORS } from "../../record/consts.ts"
import type { Fields } from "../../types.ts"

export function matchesFilter(record: Fields, filter: unknown, resolve?: (ref: string) => Fields | null): boolean {
  if (filter == null || typeof filter !== "object") return true
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "_and") {
      if (!(cond as unknown[]).every(c => matchesFilter(record, c, resolve))) return false
      continue
    }
    if (key === "_or") {
      if (!(cond as unknown[]).some(c => matchesFilter(record, c, resolve))) return false
      continue
    }
    if (!matchesField(record[key], cond, resolve)) return false
  }
  return true
}

function matchesField(value: unknown, cond: unknown, resolve?: (ref: string) => Fields | null): boolean {
  if (cond === null || typeof cond !== "object" || Array.isArray(cond)) return compare("_eq", value, cond)
  for (const [op, operand] of Object.entries(cond)) {
    if (!op.startsWith("_")) {
      // one-hop relational condition (tier 1): a non-operator key means the field holds a
      // `<collection>/<id>` ref (or an array of them) — resolve and evaluate the sub-condition
      // against the target record. array refs use _some semantics (any target matches).
      // no resolver wired, a dangling ref, or a non-ref value NARROWS, never widens — same
      // fail-closed posture as unknown operators. inbound refs are tier 2 (not supported).
      if (!resolve) return false
      const refs = (Array.isArray(value) ? value : [value]).filter((r): r is string => typeof r === "string")
      if (
        !refs.some(r => {
          const target = resolve(r)
          return target && matchesField(target[op], operand, resolve)
        })
      )
        return false
      continue
    }
    if (!compare(op, value, operand)) return false
  }
  return true
}

function compare(op: string, v: unknown, operand: unknown): boolean {
  const o = resolveTokens(operand)
  if (o === UNKNOWN_TOKEN) return false
  const s = (x: unknown): string => String(x ?? "")
  const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0)
  // array field values (tags, attendees): containment semantics for eq/contains
  const arr = Array.isArray(v)
  const vs = v as unknown[] // read only where `arr` holds
  switch (op) {
    case "_eq":
      return arr ? vs.includes(o) : looseEq(v, o)
    case "_neq":
      return v != null && !(arr ? vs.includes(o) : looseEq(v, o))
    case "_ieq":
      return s(v).toLowerCase() === s(o).toLowerCase()
    case "_nieq":
      return v != null && s(v).toLowerCase() !== s(o).toLowerCase()
    case "_lt":
      return v != null && cmp(v, o) < 0
    case "_lte":
      return v != null && cmp(v, o) <= 0
    case "_gt":
      return v != null && cmp(v, o) > 0
    case "_gte":
      return v != null && cmp(v, o) >= 0
    case "_in":
      return toArray(o).some(x => (arr ? vs.includes(x) : looseEq(v, x)))
    case "_nin":
      return v != null && !toArray(o).some(x => (arr ? vs.includes(x) : looseEq(v, x)))
    case "_null":
      return o ? v == null : v != null
    case "_nnull":
      return o ? v != null : v == null
    case "_empty":
      return o ? empty : !empty
    case "_nempty":
      return o ? !empty : empty
    case "_contains":
      return arr ? vs.some(x => s(x).includes(s(o))) : s(v).includes(s(o))
    case "_ncontains":
      return v != null && !s(v).includes(s(o))
    case "_icontains":
      return arr
        ? vs.some(x => s(x).toLowerCase().includes(s(o).toLowerCase()))
        : s(v).toLowerCase().includes(s(o).toLowerCase())
    case "_starts_with":
      return s(v).startsWith(s(o))
    case "_istarts_with":
      return s(v).toLowerCase().startsWith(s(o).toLowerCase())
    case "_ends_with":
      return s(v).endsWith(s(o))
    case "_iends_with":
      return s(v).toLowerCase().endsWith(s(o).toLowerCase())
    case "_between": {
      const [a, b] = toArray(o)
      return v != null && cmp(v, a) >= 0 && cmp(v, b) <= 0
    }
    case "_nbetween": {
      const [a, b] = toArray(o)
      return v != null && (cmp(v, a) < 0 || cmp(v, b) > 0)
    }
    case "_regex":
      try {
        return new RegExp(String(o)).test(s(v))
      } catch {
        return false
      }
    default:
      // unknown operator NARROWS, never widens (review finding 5): filters are load-bearing
      // in compiled ui-views — a typo'd _nq matching everything showed every user's tasks
      // with no signal. warn once per operator per process.
      warnUnknownOp(op)
      return false
  }
}

const warned = new Set<string>()

function warnUnknownOp(op: string): void {
  if (warned.has(op)) return
  warned.add(op)
  console.warn(
    `⚠ unknown filter operator "${op}" — treated as matching NOTHING (known: ${[...KNOWN_OPERATORS].join(", ")})`
  )
}

function resolveTokens(o: unknown): unknown {
  if (Array.isArray(o)) {
    const out = o.map(x => tokenValue(x) ?? x)
    return out.includes(UNKNOWN_TOKEN) ? UNKNOWN_TOKEN : out
  }
  return tokenValue(o) ?? o
}

const toArray = (o: unknown): unknown[] =>
  Array.isArray(o)
    ? o
    : String(o)
        .split(",")
        .map(x => x.trim())

/**
 * ordering lives in temporal.js: a date-time carries its own local offset, so `_gt`/`_lt` have to
 * compare INSTANTS. String order would put `…T12:00+03:00` after `…T11:00+01:00`, which is the
 * earlier moment. Numbers and plain strings behave exactly as before.
 */
const cmp = compareValues
