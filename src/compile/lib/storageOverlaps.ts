/**
 * Storage paths that swallow each other, as sentences — or `[]`. `entries` is `[{name, path}]`.
 *
 * ⚠ MEASURED DATA LOSS, not a hypothetical. Give collection A the path `data/health` and collection
 * B `data/health/doctors`, and A's recursive walk indexes B's records as its own: `dt A list` prints
 * B's records under A's name, `check` reports B's fields as unknown fields of A, and a write through
 * A can overwrite a record of B. compile reported ✔ through all of it, because nothing ever compared
 * two collections' paths. Namespaces make near-misses like this ordinary, so the check is no longer
 * optional.
 *
 * Segment-wise on purpose: `data/health` must not flag `data/health-notes`.
 */
export function storageOverlaps(entries: Iterable<{ name: string; path: string; base?: string }>): string[] {
  const problems: string[] = []
  const sorted = [...entries].filter(e => e.path).sort((a, b) => a.path.localeCompare(b.path))
  for (const outer of sorted) {
    for (const inner of sorted) {
      if (outer === inner || outer.base !== inner.base) continue
      if (!inner.path.startsWith(outer.path + "/")) continue
      problems.push(
        `collection "${inner.name}" stores records under "${inner.path}", which is INSIDE "${outer.name}"'s folder "${outer.path}" — the outer collection would index the inner one's records as its own. Give one of them a folder of its own.`
      )
    }
  }
  return problems
}
