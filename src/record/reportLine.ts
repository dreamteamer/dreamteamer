import type { ChangeGroup } from "./types.ts"

/** `records — contacts: 1 created, 2 updated · issues (project-a): 1 created` — the report's first
 *  line, the one the skill tells a session to end its reply with. Empty when nothing changed: the
 *  rule is that nothing written appends nothing. */
export function reportLine(groups: ChangeGroup[]): string {
  if (!groups.length) return ""
  const counts = (g: ChangeGroup): string =>
    (["created", "updated", "deleted"] as const)
      .filter(w => g[w])
      .map(w => `${g[w]} ${w}`)
      .join(", ")
  return `records — ${groups.map(g => `${g.collection}${g.layer ? ` (${g.layer})` : ""}: ${counts(g)}`).join(" · ")}`
}
