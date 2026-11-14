import type { RepoCommit } from "./types.ts"

/**
 * WHERE the schema change landed. ONE printer, because §9's whole point is that the answer is not
 * always "here": a write into a git-shape module commits in that clone, and the operator has to be
 * told — otherwise the change is in a repo they have not pushed and nothing said so.
 *
 * The workspace gets no "ahead" count on purpose: pushing the workspace is a thing the operator
 * already thinks about, and a number beside it would read as a new obligation.
 */
export function reportCommits(commits: RepoCommit[] | null | undefined): void {
  for (const c of commits ?? []) {
    if (c.repo === ".") {
      console.log(`✔ committed in the workspace${c.sha ? ` (${c.sha})` : ""}`)
      continue
    }
    const parts = [c.sha, c.ahead ? `ahead ${c.ahead} — push when ready` : null].filter(Boolean)
    console.log(`✔ committed in ${c.repo}${parts.length ? ` (${parts.join(", ")})` : ""}`)
  }
}
