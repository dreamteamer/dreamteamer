import { INVARIANT } from "./namespace.ts"

export function singular(name: string): string {
  const i = name.lastIndexOf("-")
  const head = name.slice(0, i + 1),
    w = name.slice(i + 1)
  return head + singularWord(w)
}

function singularWord(w: string): string {
  if (INVARIANT.has(w)) return w
  if (/yses$/.test(w)) return w.replace(/yses$/, "ysis")
  if (/[^aeiou]ies$/.test(w)) return w.replace(/ies$/, "y")
  if (/(sses|shes|ches|xes|zes)$/.test(w)) return w.replace(/es$/, "")
  if (/uses$/.test(w)) return w.replace(/es$/, "")
  if (/ss$/.test(w)) return w
  if (/s$/.test(w)) return w.slice(0, -1)
  return w
}
