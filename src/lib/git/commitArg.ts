/**
 * A revision a caller hands to git: a commit id (4 to 40 hex digits) or HEAD — with `relative`,
 * also `HEAD~<n>`, the spelling `dt changes --since` documents. git reads a revision that starts
 * with a dash as an option, and some options write files, so anything else is refused before git
 * runs; the argv still puts it after `--end-of-options`.
 */
const COMMIT = /^(?:HEAD|[0-9a-fA-F]{4,40})$/

const RELATIVE = /^(?:HEAD(?:~\d+)?|[0-9a-fA-F]{4,40})$/

export function commitArg(rev: unknown, relative = false): string {
  if (typeof rev !== "string" || !(relative ? RELATIVE : COMMIT).test(rev))
    throw new Error(`${JSON.stringify(rev)} is not a commit id — give a commit hash (4 to 40 hex digits) or HEAD`)
  return rev
}
