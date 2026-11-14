export const KNOWN_HARNESSES = ["claude-code", "codex", "pi", "gemini-cli", "cursor"]

// ⚠ THE VALUES ARE A CONTRACT, not an implementation detail: every managed root file on every disk
// already carries these two exact strings, and a tool that merges branches (a worktree
// extension's `land`) classifies a conflict by asking whether its hunks lie between them. Changing a byte orphans
// every block ever written and silently reclassifies a generated conflict as the operator's own prose.
export const BEGIN = "<!-- dreamteamer:begin (generated — do not edit inside this block) -->"

export const END = "<!-- dreamteamer:end -->"

// A SECOND managed block, deliberately not folded into the orientation one. Separate delimiters
// keep the orientation block's asserted size budget meaningful, and let `dreamteamer.md` be removed
// on its own without the removal touching anything generated from the schema.
export const INSTRUCTIONS_BEGIN = "<!-- dreamteamer:instructions:begin -->"

export const INSTRUCTIONS_END = "<!-- dreamteamer:instructions:end -->"

/** One flattened line of prose from a possibly-folded YAML scalar. */
export const flat = (s: unknown): string =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
