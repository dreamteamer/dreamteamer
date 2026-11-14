import { tryGit } from "../lib/git/tryGit.ts"

export const commitOf = (dest: string, rev: string): string | null =>
  tryGit(dest, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])
