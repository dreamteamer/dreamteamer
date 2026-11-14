import { VALUE_TOKENS } from "../record/filter.ts"
import { unknownOperators } from "../record/unknownOperators.ts"
import { unknownTokens } from "../record/unknownTokens.ts"
import type { Field } from "../types.ts"
import { filterFields } from "./filterFields.ts"
import type { ViewCheck } from "./types.ts"
import { has, isMap } from "./views.ts"

/** The keys a command-binding carries. */
const BINDING_KEYS = ["command", "collection", "scope", "available_when", "done_when", "description"]

const BINDING_SCOPES = ["record", "collection"]

const V1_BINDING_KEYS = ["target", "can-enter", "can-exit"]

/**
 * Validate one command-binding.
 * @returns {{ errors: string[], warnings: string[], v1?: true }}
 */
export function bindingErrors(
  b: unknown,
  { file, fields, lenient = false }: { file: string; fields?: Record<string, Field>; lenient?: boolean }
): ViewCheck {
  if (!isMap(b)) return { errors: [`${file}: a command-binding is a mapping`], warnings: [] }
  if (V1_BINDING_KEYS.some(k => k in b)) return { v1: true, errors: [], warnings: [] }
  const errors: string[] = []
  const warnings: string[] = []
  for (const k of Object.keys(b))
    if (!BINDING_KEYS.includes(k))
      errors.push(`${file}: unknown key \`${k}\` — a command-binding's keys are ${BINDING_KEYS.join(" · ")}`)
  if (b.scope !== undefined && !BINDING_SCOPES.includes(b.scope as string))
    errors.push(`${file}: \`scope\` is ${BINDING_SCOPES.join(" · ")}`)
  for (const key of ["available_when", "done_when"]) {
    if (b[key] === undefined) continue
    if (!isMap(b[key])) {
      errors.push(`${file}: \`${key}\` is a mapping of field → condition`)
      continue
    }
    const bad = [...unknownOperators(b[key])]
    if (bad.length) errors.push(`${file}: ${key} has unknown filter operator(s) ${bad.join(", ")}`)
    const tokens = [...unknownTokens(b[key])]
    if (tokens.length)
      errors.push(
        `${file}: ${key} holds unknown value token(s) ${tokens.join(", ")} — the tokens are ${VALUE_TOKENS.join(" and ")}`
      )
    if (fields)
      for (const f of filterFields(b[key]))
        if (!has(fields, f))
          (lenient ? warnings : errors).push(`${file}: ${key} names "${f}", which is not a field of ${b.collection}`)
    if (b.scope === "collection")
      warnings.push(`${file}: ${key} is read by nothing — a collection-scope binding evaluates no record`)
  }
  return { errors, warnings }
}
