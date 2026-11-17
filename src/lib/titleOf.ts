/** a name as a label, the released engine's way: each word capitalised (`last_modified` is `Last Modified`) */
export function titleOf(name: string): string {
  return name
    .split(/[_\-\s/]+/)
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(" ")
}
