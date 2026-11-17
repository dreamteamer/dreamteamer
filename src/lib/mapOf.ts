import { isObject } from "./isObject.ts"

/** a map of names to values, or an empty one for anything else: how a reader looks into an optional block */
export function mapOf(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {}
}
