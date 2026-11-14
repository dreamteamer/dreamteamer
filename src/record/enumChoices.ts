/** The enum's decoration per value — `{ value: { label, description, icon, color, background } }` — from a map; {} from a list. */
export function enumChoices(e: unknown): Record<string, Record<string, string>> {
  if (!e || Array.isArray(e) || typeof e !== "object") return {}
  const out: Record<string, Record<string, string>> = {}
  for (const [v, row] of Object.entries(e)) {
    if (!row || typeof row !== "object") continue
    const r: Record<string, string> = {}
    for (const k of ["label", "description", "icon", "color", "background"])
      if (typeof (row as Record<string, unknown>)[k] === "string") r[k] = (row as Record<string, string>)[k]
    out[v] = r
  }
  return out
}
