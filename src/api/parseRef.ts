/**
 * Split a reference into collection and id at the end of a declared namespace, else at the first slash; null when it
 * is not `<collection>/<id>`. Syntactic, as the released engine's: the collection need not exist.
 */
export function parseRef(ref: unknown, namespaces: string[] = []) {
  if (typeof ref !== "string" || !ref) return null
  const ns = namespaces.find((t) => ref.startsWith(t + "/"))
  const base = ns ? ns.length + 1 : 0
  const slash = ref.indexOf("/", base)
  if (slash < base + 1 || slash === ref.length - 1) return null
  const res = { collection: ref.slice(0, slash), id: ref.slice(slash + 1) }
  return res
}
