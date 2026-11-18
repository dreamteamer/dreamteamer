import path from "node:path"
import fs from "node:fs"

/** `.env.example` lists every env key the installed modules declare — the file the missing-key
 *  warning points at, which used to carry two comment lines and none of the keys it was cited for.
 *  A key already named in the file (as `KEY=` or `# KEY`) is not added again, and nothing an operator
 *  wrote is touched. Values never appear here — an example does.
 *
 *  The blocks THIS function wrote follow the declarations (rnd/issues …env-example-keeps-a-key-under-
 *  its-old-package…): an engine block is a `KEY=` line directly under `# declared by <packages>` or
 *  `# <description> (module <packages>)`. Its comment is rewritten when what declares the key changed
 *  (`moved`; the `KEY=` line, whose example may be the operator's, stays), and the block goes when no
 *  installed package declares the key (`dropped`) — unless `keep` names it (the workspace's own
 *  declaration) or the module set is not `complete` (a declared module not on disk yet: its keys would
 *  go and come back). A repeated engine block for one key goes with the first one's rewrite. Every
 *  other line is kept byte for byte, its line ending included. Returns `{ added, moved, dropped }`. */
export function ensureEnvExample(
  root: string,
  entries: { key: string; modules?: string[]; description?: string; example?: string }[],
  header = "",
  { keep = [], complete = true }: { keep?: string[]; complete?: boolean } = {}
): { added: string[]; moved: string[]; dropped: string[] } {
  const file = path.join(root, ".env.example")
  const exists = fs.existsSync(file)
  const result = { added: [] as string[], moved: [] as string[], dropped: [] as string[] }
  if (!entries.length && !exists) return result
  const existing = exists ? fs.readFileSync(file, "utf8") : header
  const declared = new Map(entries.map(e => [e.key, e]))
  const commentFor = (e: (typeof entries)[number]): string =>
    `# ${e.description ?? `declared by ${e.modules.join(", ")}`}${e.description && e.modules?.length ? ` (module ${e.modules.join(", ")})` : ""}`
  const lines = existing.split(/(?<=\n)/) // each line keeps its own ending
  const text = (l: string): string => l.replace(/\r?\n$/, "")
  const ENGINE = /^# (?:declared by .+|.* \(module .+\))$/
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(text(lines[i]))?.[1]
    const prev = out.length - 1
    if (!key || prev < 0 || !ENGINE.test(text(out[prev])) || !complete) {
      out.push(lines[i])
      continue
    }
    const e = declared.get(key)
    if (e && !seen.has(key)) {
      seen.add(key)
      const want = commentFor(e)
      if (text(out[prev]) !== want) {
        out[prev] = want + out[prev].slice(text(out[prev]).length)
        result.moved.push(key)
      }
      out.push(lines[i])
      continue
    }
    if (!e && keep.includes(key)) {
      out.push(lines[i])
      continue
    }
    // a key nothing declares, or a second engine block for one: the comment, the key and the blank line before them go
    out.pop()
    if (out.length && text(out[out.length - 1]) === "") out.pop()
    else if (!out.length && i + 1 < lines.length && text(lines[i + 1]) === "") i++ // at the top of the file: the blank line after
    if (!e && !result.dropped.includes(key)) result.dropped.push(key)
  }
  let next = out.join("")
  // what is named after the drops: a dropped key is no longer named, so it is never added back here
  const named = new Set([...next.matchAll(/^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(m => m[1]))
  const eol = existing.includes("\r\n") ? "\r\n" : "\n"
  for (const e of entries) {
    if (named.has(e.key)) continue
    next = next.trimEnd() + `${eol}${eol}${commentFor(e)}${eol}${e.key}=${e.example ?? ""}${eol}`
    named.add(e.key)
    result.added.push(e.key)
  }
  if (result.added.length) next = next.replace(/^(?:\r?\n)+/, "")
  if (next !== existing) fs.writeFileSync(file, next)
  return result
}
