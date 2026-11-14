import path from "node:path"
import fs from "node:fs"

/**
 * The harness files compile generates at the workspace root (CLAUDE.md, AGENTS.md, GEMINI.md and any
 * an extension writes) are build output, gitignored like `.claude/` and `.agents/`. Append-if-missing,
 * root-anchored so a module's own CLAUDE.md is never ignored. Returns the lines it added.
 */
export function ensureGitignored(root: string, files: string[]): string[] {
  const file = path.join(root, ".gitignore")
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const have = new Set(existing.split("\n").map(l => l.trim()))
  const missing = files.map(f => `/${f}`).filter(l => !have.has(l))
  if (missing.length) fs.writeFileSync(file, (existing ? existing.trimEnd() + "\n" : "") + missing.join("\n") + "\n")
  return missing
}
