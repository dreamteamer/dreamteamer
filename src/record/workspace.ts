import path from "node:path"
import fs from "node:fs"

/** The VS Code-family extensions for this workspace, as the editor learns of them: recommendations
 *  in `.vscode/extensions.json`, which VS Code, Cursor and code-server all read on open and offer to
 *  install. The studio extension, and beside it Claude Code, the agent a workspace's harness files are
 *  compiled for. Written by `init` and kept current by `compile`, because a compiled workspace that
 *  never names its editor left a first-run agent searching a registry for the id (measured 2026-09-24:
 *  three install attempts, two of them into a directory the running editor did not read). An
 *  existing file is MERGED, never replaced: an id the file already names anywhere — recommended, or
 *  listed under `unwantedRecommendations` by an operator who declined it — counts as present, in any
 *  case (extension ids are case-insensitive); a file naming them all is left byte-for-byte alone; one
 *  missing some is re-read as JSON and gains them, and one that is not plain JSON is left with a
 *  warning rather than clobbered. */
export const EDITOR_EXTENSION_ID = "dreamteamer.dreamteamer-vscode"

export const EDITOR_RECOMMENDATIONS = [EDITOR_EXTENSION_ID, "Anthropic.claude-code"]

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
