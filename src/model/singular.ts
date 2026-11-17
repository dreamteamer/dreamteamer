const INVARIANT = new Set(["series", "species", "news"])

function singularWord(w: string) {
  if (INVARIANT.has(w)) return w
  if (w.endsWith("yses")) return w.slice(0, -4) + "ysis"
  if (/[^aeiou]ies$/.test(w)) return w.slice(0, -3) + "y"
  if (/(sses|shes|ches|xes|zes|uses)$/.test(w)) return w.slice(0, -2)
  if (w.endsWith("ss")) return w
  return w.endsWith("s") ? w.slice(0, -1) : w
}

/** a collection's name in the singular: the last word of its last segment is inflected (`rnd/user-stories` → `rnd/user-story`) */
export function singular(name: string): string {
  const cut = Math.max(name.lastIndexOf("/"), name.lastIndexOf("-")) + 1
  return name.slice(0, cut) + singularWord(name.slice(cut))
}
