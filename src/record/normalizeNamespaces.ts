/**
 * The declared list, cleaned and ordered for prefix matching: de-duplicated, slash-trimmed, and
 * sorted LONGEST FIRST so a nested namespace (`work/clients`) is tested before its parent (`work`).
 * Order is the correctness property here, not a nicety — parent-first would claim `work/clients/acme`
 * for the namespace `work`, making the collection `clients` and the id `acme` on a workspace where
 * `work/clients` is the namespace and the collection is something else entirely.
 */
export function normalizeNamespaces(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  for (const raw of list) {
    if (typeof raw !== "string") continue
    const ns = raw.trim().replace(/^\/+|\/+$/g, "")
    if (ns) seen.add(ns)
  }
  return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b))
}
