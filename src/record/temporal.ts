/** `+0300` / `+03:00` / `z` → `+03:00` / `Z`. One spelling on disk keeps diffs quiet. */
export function canonicalZone(zone: string | undefined): string | null {
  if (!zone) return null
  if (/^z$/i.test(zone)) return "Z"
  return zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone
}
