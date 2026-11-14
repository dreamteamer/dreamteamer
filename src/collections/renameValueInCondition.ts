import { PARTIAL_OPS } from "./consts.ts"
import { asTree } from "./schema-ops.ts"
import { LIST_OPS, VALUE_OPS } from "./consts.ts"
import type { At, Tree } from "./types.ts"

/** One field's condition in a filter, with the value rewritten. */
export function renameValueInCondition(node: Tree, key: string, from: string, to: string, at: At, label: string): void {
  if (node[key] === from) {
    node[key] = to
    at(`${label}.${key}`)
    return
  }
  const cond = asTree(node[key])
  if (!cond) return
  for (const op of VALUE_OPS)
    if (cond[op] === from) {
      cond[op] = to
      at(`${label}.${key}.${op}`)
    }
  for (const op of LIST_OPS) {
    const o = cond[op]
    if (Array.isArray(o) && o.includes(from)) {
      cond[op] = o.map(v => (v === from ? to : v))
      at(`${label}.${key}.${op}`)
    } else if (
      typeof o === "string" &&
      o
        .split(",")
        .map(x => x.trim())
        .includes(from)
    ) {
      cond[op] = o
        .split(",")
        .map(x => (x.trim() === from ? to : x.trim()))
        .join(",")
      at(`${label}.${key}.${op}`)
    }
  }
  for (const [op, selects] of Object.entries(PARTIAL_OPS)) {
    const o = cond[op]
    if (typeof o === "string" && o !== "" && selects(from, o))
      at(
        `${label}.${key}.${op}`,
        `\`${op}: ${cond[op]}\` selects "${from}" by part of its spelling — say what it should select now, by hand`
      )
  }
}
