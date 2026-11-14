// the reader's assignment, with the value token captured: KEY=value · KEY="…" (spans lines) · KEY='…'
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\n]*)$/gm

/** Every assignment in `.env` text, in file order: `{ key, start, end, raw, value, quoted }` where
 *  `[start, end)` is the value token's span (an unquoted value without its trailing whitespace, so a
 *  CRLF file keeps its `\r`), `raw` the text there, `value` what parseEnvValues reads, `quoted` the
 *  quote character or false. */
/** One assignment's value token in `.env` text: its key, its span, the raw text, what the reader reads, its quote. */
type EnvSpan = { key: string; start: number; end: number; raw: string; value: string; quoted: '"' | "'" | false }

export function envSpans(text: string): EnvSpan[] {
  const out: EnvSpan[] = []
  // a leading byte-order mark is not part of the first key: scanned as if absent, offsets kept (it is one
  // UTF-16 unit, replaced by one newline so `^` still matches the first line)
  const body = String(text).replace(/^\uFEFF/, "\n")
  for (const m of body.matchAll(ASSIGNMENT)) {
    let raw = m[2]
    const quoted =
      raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
        ? '"'
        : raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2
          ? "'"
          : false
    if (!quoted) raw = raw.replace(/\s+$/, "")
    const start = m.index + m[0].length - m[2].length
    out.push({ key: m[1], start, end: start + raw.length, raw, value: quoted ? raw.slice(1, -1) : raw.trim(), quoted })
  }
  return out
}
