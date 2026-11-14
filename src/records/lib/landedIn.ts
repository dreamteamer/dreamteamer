/** What a write on an EXISTING record adds to its `✔` line: nothing in the workspace's own repo; the
 *  repo when it is another clone (a layer, a module's list); and that it is never committed when the
 *  root is outside every repo here. The workspace name alone used to be printed wherever it landed. */
export function landedIn(where: { file: string; repo: string | null }): string {
  if (!where) return ""
  const { repo } = where
  if (repo === null) return " — outside every git repo here, never committed"
  return repo === "." ? "" : ` in ${repo}`
}
