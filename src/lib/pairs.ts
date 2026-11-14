/** `field=value` positionals, with the same promote-on-repeat rule the flags have. It was
 *  `Object.fromEntries`, which keeps the LAST pair — `dt set c/id tags=a tags=b` wrote `[b]`. */
export function pairs(list: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const p of list) {
    if (!p.includes("=")) continue
    const k = p.slice(0, p.indexOf("="))
    const v = p.slice(p.indexOf("=") + 1)
    out[k] = k in out ? ([] as string[]).concat(out[k], v) : v
  }
  return out
}
