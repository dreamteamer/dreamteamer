import { lineEnd } from "./yaml.ts"

/**
 * Where a node's source really ends. `range[1]` stops at the VALUE, so a trailing `# comment` sits
 * outside it and its alignment is lost with it.
 *
 * ⚠ Counts COMMENT lines, not total lines, and takes the count from the ORIGINAL side. The two sides
 * spell one comment differently: a source writes `icon: star   # why` on one line, while the library
 * re-emits a MULTI-line comment on lines of its own — so the same comment spans two lines in the
 * source and three in the output. A following line is only ever consumed when it is nothing but a
 * comment, so a wrong count can shorten the span but can never swallow content.
 */
export function endOf(text: string, from: number, lines: number): number {
  if (lines <= 0) return from
  let end = lineEnd(text, from)
  let got = text.slice(from, end).includes("#") ? 1 : 0
  while (got < lines && end < text.length) {
    const next = lineEnd(text, end + 1)
    if (!/^\s*#/.test(text.slice(end + 1, next))) break
    end = next
    got++
  }
  return end
}
