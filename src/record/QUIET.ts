import type { StdioOptions } from "node:child_process"

// git calls whose failure we CATCH must not print git's own error: execFileSync forwards the
// child's stderr to ours unless told otherwise, so a handled "not a git repository" still
// reached the user's terminal. stdout stays piped because we read it.
export const QUIET: StdioOptions = ["ignore", "pipe", "ignore"]
