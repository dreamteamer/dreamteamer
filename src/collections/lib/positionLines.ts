/**
 * The positions a positional verb rewrites (or refuses on), one line each — what `--dry-run` is
 * for: the operator reads WHERE before deciding.
 */
export function positionLines(positions: { rel: string; at: string; fixed: boolean; why?: string }[]): string[] {
  return positions.map(p => `${p.fixed ? "  " : "✖ "}${p.rel}  ${p.at}${p.fixed ? "" : ` — ${p.why}`}`)
}
