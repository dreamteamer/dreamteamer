import type { StdioOptions } from "node:child_process"

// Same rule as store.js: a git failure we CATCH must not also print git's own error on top of the
// clean message we throw. stdout stays piped because some callers read it.
export const GIT_QUIET: StdioOptions = ["ignore", "pipe", "ignore"]
