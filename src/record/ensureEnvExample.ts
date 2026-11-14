import path from "node:path"
import fs from "node:fs"

/** `.env.example` lists every env key the installed modules declare — the file the missing-key
 *  warning points at, which used to carry two comment lines and none of the keys it was cited for.
 *  Append-only and idempotent: a key already named in the file (as `KEY=` or `# KEY`) is not added
 *  again, and nothing an operator wrote is touched. Values never appear here — an example does. */
export function ensureEnvExample(
  root: string,
  entries: { key: string; modules?: string[]; description?: string; example?: string }[],
  header = ""
): string[] {
  if (!entries.length) return []
  const file = path.join(root, ".env.example")
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : header
  const named = new Set([...existing.matchAll(/^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(m => m[1]))
  const added: string[] = []
  let out = existing
  for (const e of entries) {
    if (named.has(e.key)) continue
    const who = e.modules?.length ? ` (module ${e.modules.join(", ")})` : ""
    out =
      out.trimEnd() +
      `\n\n# ${e.description ?? `declared by ${e.modules.join(", ")}`}${e.description ? who : ""}\n${e.key}=${e.example ?? ""}\n`
    added.push(e.key)
  }
  if (added.length) fs.writeFileSync(file, out.replace(/^\n+/, ""))
  return added
}
