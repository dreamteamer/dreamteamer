import { KNOWN_OPERATORS } from "./KNOWN_OPERATORS.ts"

// walk a filter tree and return every operator key not in the known set — compile
// validates ui-view filters with this so a typo'd operator fails loudly at compile time.
export function unknownOperators(filter: unknown, found = new Set<string>()): Set<string> {
  if (filter == null || typeof filter !== "object") return found
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "_and" || key === "_or") {
      for (const c of Array.isArray(cond) ? cond : []) unknownOperators(c, found)
    } else if (key.startsWith("_")) {
      if (!KNOWN_OPERATORS.has(key)) found.add(key)
    } else if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      // field conditions recurse like filters: operator maps at any depth are checked,
      // and non-operator keys (one-hop relational conditions) descend into their sub-filter
      unknownOperators(cond, found)
    }
  }
  return found
}
