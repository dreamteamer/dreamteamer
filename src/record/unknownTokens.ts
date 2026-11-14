import { TOKEN, VALUE_TOKENS } from "./filter.ts"

/** Every `$token` value in a filter tree that is not one of VALUE_TOKENS — what compile and
 *  `--where` refuse. */
export function unknownTokens(filter: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof filter === "string") {
    if (TOKEN.test(filter) && !VALUE_TOKENS.includes(filter)) found.add(filter)
    return found
  }
  if (filter == null || typeof filter !== "object") return found
  for (const v of Array.isArray(filter) ? filter : Object.values(filter)) unknownTokens(v, found)
  return found
}
