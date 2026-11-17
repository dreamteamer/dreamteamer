import { isDeepStrictEqual } from "node:util"
import { isObject } from "../lib/isObject.ts"
import type { Rule } from "../types/Rule.ts"

const NO = Symbol("no")

/** a value that is not a map or a list */
function scalar(v: unknown) {
  return v === null || typeof v !== "object"
}

/**
 * A value as a JSON Schema type, or NO. The released engine's validator converts a value to the type it is checked
 * against where it can (`coerceTypes: "array"`): null is an empty text, "5" is a number, a text is a list of one, a
 * list of one is its item. A value already of the type is returned as it is.
 */
function as(t: string, v: unknown): unknown {
  if (Array.isArray(v)) return t === "array" ? v : v.length === 1 && scalar(v[0]) ? as(t, v[0]) : NO
  if (t === "array") return isObject(v) ? NO : [v]
  if (t === "object" || isObject(v)) return t === "object" && isObject(v) ? v : NO
  if (t === "string")
    return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : ""
  if (t === "null") return v === null || v === "" || v === 0 || v === false ? null : NO
  if (t === "boolean")
    return typeof v === "boolean"
      ? v
      : v === "true" || v === 1
        ? true
        : v === "false" || v === 0 || v === null
          ? false
          : NO
  const n = typeof v === "string" ? (v === "" ? NaN : Number(v)) : v === null ? 0 : typeof v === "boolean" ? +v : v
  return typeof n === "number" && Number.isFinite(n) && (t === "number" || Number.isInteger(n)) ? n : NO
}

/** the number of characters in a text, as JSON Schema counts them: by code point */
function length(s: string) {
  return [...s].length
}

/**
 * What is wrong with a value under a rule, each message led by the path inside the record (`at`, empty for the
 * record itself); none when the value satisfies it. Each keyword means what JSON Schema says it means: `properties`
 * and `required` look only at a map, `items` only at a list, and `if` picks `then` or `else` without failing itself.
 * A value `type` converts is written back through `put`, so every keyword and rule after it reads the converted
 * value, as the released engine's validator reads it.
 */
export function checkRule(r: Rule, v: unknown, at = "", put?: (x: unknown) => void): string[] {
  const out: string[] = []
  const say = (m: string) => out.push(at ? `${at}: ${m}` : m)
  const inner = (k: string | number) => (typeof k === "number" ? `${at}[${k}]` : at ? `${at}.${k}` : k)
  const holds = (t: Rule) => !checkRule(t, v, at, put).length
  if (r.type && !r.type.some((t) => as(t, v) === v)) {
    const to = r.type.map((t) => as(t, v)).find((t) => t !== NO)
    if (to === undefined) say(`expected ${r.type.join(" or ")}`)
    else put?.((v = to))
  }
  if (r.const && !isDeepStrictEqual(v, r.const.value)) say(`must be ${JSON.stringify(r.const.value)}`)
  if (r.enum && !r.enum.some((t) => isDeepStrictEqual(t, v)))
    say(`not one of ${r.enum.map((t) => JSON.stringify(t)).join(" | ")}`)
  if (typeof v === "string") {
    if (r.pattern !== undefined && !new RegExp(r.pattern, "u").test(v)) say(`does not match ${r.pattern}`)
    if (r.minLength !== undefined && length(v) < r.minLength) say(`shorter than ${r.minLength} characters`)
    if (r.maxLength !== undefined && length(v) > r.maxLength) say(`longer than ${r.maxLength} characters`)
  }
  if (typeof v === "number") {
    if (r.minimum !== undefined && v < r.minimum) say(`less than the minimum ${r.minimum}`)
    if (r.maximum !== undefined && v > r.maximum) say(`more than the maximum ${r.maximum}`)
  }
  if (Array.isArray(v)) {
    if (r.minItems !== undefined && v.length < r.minItems) say(`fewer than ${r.minItems} items`)
    if (r.maxItems !== undefined && v.length > r.maxItems) say(`more than ${r.maxItems} items`)
    const items = r.items
    if (items) v.forEach((t, i, a) => out.push(...checkRule(items, t, inner(i), (x) => (a[i] = x))))
  }
  if (isObject(v)) {
    const o = v
    for (const k of r.required ?? []) if (o[k] === undefined) out.push(`${inner(k)}: required`)
    for (const [k, t] of Object.entries(r.properties ?? {}))
      if (o[k] !== undefined) out.push(...checkRule(t, o[k], inner(k), (x) => (o[k] = x)))
  }
  for (const t of r.allOf ?? []) out.push(...checkRule(t, v, at, put))
  if (r.anyOf && !r.anyOf.some(holds)) say("matches none of the alternatives (anyOf)")
  if (r.oneOf && r.oneOf.filter(holds).length !== 1) say("must match exactly one of the alternatives (oneOf)")
  if (r.not && holds(r.not)) say("matches what the rule rules out (not)")
  const branch = r.if && (holds(r.if) ? r.then : r.else)
  if (branch) out.push(...checkRule(branch, v, at, put))
  return out
}
