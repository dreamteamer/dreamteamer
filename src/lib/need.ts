export function need(pos: string[], i: number, what: string): string {
  if (pos[i] === undefined) throw new Error(`missing <${what}>`)
  return pos[i]
}
