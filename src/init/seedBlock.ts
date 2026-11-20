import type { DreamteamerBlock, Flags } from "../types.ts"
import { KNOWN_HARNESSES } from "../compile/consts.ts"

/**
 * The `dreamteamer` block init leaves in package.json: its seeds, under whatever the EXISTING block
 * already says — the existing key always wins over a flag. One function, because `init --ready` must
 * judge exactly the paths init will write, and a second copy of this precedence is how it did not.
 */
export function seedBlock(flags: Flags = {}, existing: DreamteamerBlock = {}): DreamteamerBlock {
  // EVERY known harness by default, and this is the operator's explicit call over the architecture
  // review's dissent — recorded, not elided: it writes AGENTS.md, GEMINI.md and .cursor/rules/ into
  // every new workspace, which is real clutter. The decision stands on the ASYMMETRY. A missing
  // adapter fails SILENTLY: the session opens, the agent reads no orientation block, and it models
  // the workspace by guessing — which is indistinguishable from the engine working. A spare adapter
  // is an empty file the operator deletes in one command. One of those two failures is recoverable.
  // `--harnesses claude-code` still narrows it, and an EXISTING workspace is untouched: the
  // `harnesses` key already exists and wins over the seed.
  const harnesses =
    typeof flags.harnesses === "string" ? flags.harnesses.split(",").map(s => s.trim()) : [...KNOWN_HARNESSES]
  return {
    // a flag's value is a string unless it was given bare; `dt init` refuses a non-string path before writing (checkout)
    data_path: (flags.data_path ?? "data") as string,
    harnesses,
    gitignore_runtime_folder: true,
    // The workspace's own sources live in `modules/default/`, and the folder is named for its ROLE,
    // not for the vault. It used to be named after the workspace, and that name went stale TWICE in
    // one repo (decision 213, reversed by 224) — each rename rewriting every path that RESOLVES
    // while the historical documents deliberately kept the old spelling, so the old `modules/<vault>`
    // was correct in prose and a bug in a path. A role name cannot go stale.
    //
    // `default` is deliberately the same word `RESERVED_NAMESPACES` holds (namespace.js): this module
    // owns the DEFAULT-namespace collections, and the default namespace is the empty prefix. The one
    // misreading it invites — `default/tasks` — is a compile error whose message states the rule.
    // Override with `--workspace_module <name>` if a workspace wants its own spelling.
    workspace_module: (flags.workspace_module ?? "default") as string,
    disable: [],
    ...existing,
  }
}
