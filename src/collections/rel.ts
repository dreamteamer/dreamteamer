export function rel(root: string, p: string): string {
  return p.startsWith(root) ? p.slice(root.length + 1) : p
}
