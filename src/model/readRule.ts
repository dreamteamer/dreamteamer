import { DtError } from "../lib/DtError.ts"
import { asArray } from "../lib/asArray.ts"
import { asObject } from "../lib/asObject.ts"
import { asString } from "../lib/asString.ts"
import { asStrings } from "../lib/asStrings.ts"
import { kindOf } from "../lib/kindOf.ts"
import type { Rule } from "../types/Rule.ts"

const TYPES = ["string", "number", "integer", "boolean", "null", "object", "array"]
const BOUNDS = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const
/** keywords that say what a rule is for and change no verdict */
const NOTES = ["description", "title", "$comment"]
const KEYWORDS = [
  "if",
  "then",
  "else",
  "not",
  "allOf",
  "anyOf",
  "oneOf",
  "properties",
  "items",
  "required",
  "const",
  "enum",
  "type",
  "pattern",
  ...BOUNDS,
]

function bound(v: unknown, where: string) {
  if (typeof v !== "number") throw new DtError(`${where}: expected a number, found ${kindOf(v)}`)
  return v
}

/**
 * A constraint as a rule, or a DtError that says where it uses a keyword this engine does not evaluate, or uses one
 * wrongly. `where` is the path of `raw` inside the descriptor.
 */
export function readRule(raw: unknown, where: string): Rule {
  const o = asObject(raw, where)
  for (const k of Object.keys(o))
    if (!KEYWORDS.includes(k) && !NOTES.includes(k))
      throw new DtError(
        `${where}: "${k}" is a keyword this engine does not evaluate — a constraint uses ${KEYWORDS.join(" ")}`,
      )
  const sub = (k: string) => (o[k] === undefined ? undefined : readRule(o[k], `${where}.${k}`))
  const subs = (k: string) => (o[k] === undefined ? undefined : asArray(o[k], `${where}.${k}`, readRule))
  const type =
    o.type === undefined ? undefined : typeof o.type === "string" ? [o.type] : asStrings(o.type, `${where}.type`)
  for (const t of type ?? [])
    if (!TYPES.includes(t)) throw new DtError(`${where}.type: "${t}" is not a JSON Schema type — ${TYPES.join(" ")}`)
  const r: Rule = {
    if: sub("if"),
    then: sub("then"),
    else: sub("else"),
    not: sub("not"),
    allOf: subs("allOf"),
    anyOf: subs("anyOf"),
    oneOf: subs("oneOf"),
    properties:
      o.properties === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(asObject(o.properties, `${where}.properties`)).map(([k, t]) => [
              k,
              readRule(t, `${where}.properties.${k}`),
            ]),
          ),
    items: sub("items"),
    required: o.required === undefined ? undefined : asStrings(o.required, `${where}.required`),
    const: "const" in o ? { value: o.const } : undefined,
    enum: o.enum === undefined ? undefined : asArray(o.enum, `${where}.enum`, (t) => t),
    type,
    pattern: o.pattern === undefined ? undefined : asString(o.pattern, `${where}.pattern`),
  }
  try {
    if (r.pattern !== undefined) new RegExp(r.pattern, "u")
  } catch {
    throw new DtError(`${where}.pattern: not a regular expression`)
  }
  for (const k of BOUNDS) if (o[k] !== undefined) r[k] = bound(o[k], `${where}.${k}`)
  return r
}
