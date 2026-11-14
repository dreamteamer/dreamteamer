import path from "node:path"
import { readManifest } from "./runtime.ts"
import type { Manifest } from "../types.ts"

/**
 * Absolute directories that may hold the SOURCES behind runtime-based records — every compiled
 * module except npm copies (foreign installed artifacts, never rewrite targets), plus the workspace
 * root. Used by ref surgery: renaming `collections/x` has to reach the descriptor in whichever
 * module ships it, not the merged copy under `.dreamteamer/`.
 *
 * Read from the manifest rather than by re-running module discovery, which is both cheaper and more
 * honest: the manifest records what was actually compiled, so a shadowed copy is already excluded.
 */
export function sourceRoots(root: string): string[] {
  const modules = readManifest(root)?.modules ?? []
  // ⚠ EITHER SPELLING. `location` is what this engine writes; `channel` is what every runtime on
  // disk before 0.19.0 has, and a stale runtime is the NORMAL state between a `git pull` and the
  // next `dt compile`. Reading only the new key would silently make this list the workspace root
  // alone — and this list is what ref surgery walks, so "silently fewer modules" means a rename
  // that reports ✔ and leaves half the references dangling.
  const isNpm = (m: Manifest["modules"][number]): boolean =>
    m.location ? m.location === "node_modules" : m.channel === "npm"
  const roots = [root, ...modules.filter(m => !isNpm(m)).map(m => path.resolve(root, m.root))]
  return [...new Set(roots)]
}
