export function parseEnvValues(text: string): Map<string, string> {
  const out = new Map()
  // KEY=value with optional `export `, optional quotes; value is whatever follows on the SAME line
  const re = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\n]*)$/gm
  let m
  while ((m = re.exec(text))) {
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out.set(m[1], v)
  }
  return out
}
