import { asTree, renameKey } from "./schema-ops.ts"
import type { At } from "./types.ts"

export function renameInConstraint(c: unknown, from: string, to: string, at: At, label: string): void {
  const node = asTree(c)
  if (!node) return
  const props = asTree(node.properties)
  if (props && from in props) {
    node.properties = renameKey(props, from, to)
    at(`${label}.properties.${from}`, undefined, to)
  }
  if (Array.isArray(node.required) && node.required.includes(from)) {
    node.required = node.required.map(r => (r === from ? to : r))
    at(`${label}.required`)
  }
  const depReq = asTree(node.dependentRequired)
  if (depReq) {
    let dr = depReq
    if (from in dr) {
      dr = node.dependentRequired = renameKey(dr, from, to)
      at(`${label}.dependentRequired.${from}`, undefined, to)
    }
    for (const [k, list] of Object.entries(dr)) {
      if (Array.isArray(list) && list.includes(from)) {
        dr[k] = list.map(r => (r === from ? to : r))
        at(`${label}.dependentRequired.${k}`)
      }
    }
  }
  const depSchemas = asTree(node.dependentSchemas)
  if (depSchemas) {
    let ds = depSchemas
    if (from in ds) {
      ds = node.dependentSchemas = renameKey(ds, from, to)
      at(`${label}.dependentSchemas.${from}`, undefined, to)
    }
    for (const [k, sub] of Object.entries(ds)) renameInConstraint(sub, from, to, at, `${label}.dependentSchemas.${k}`)
  }
  for (const k of ["if", "then", "else", "not"]) renameInConstraint(node[k], from, to, at, `${label}.${k}`)
  for (const k of ["allOf", "anyOf", "oneOf"]) {
    const subs = node[k]
    ;(Array.isArray(subs) ? subs : []).forEach((sub: unknown, i: number) =>
      renameInConstraint(sub, from, to, at, `${label}.${k}[${i}]`)
    )
  }
}
