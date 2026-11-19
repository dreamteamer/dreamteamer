import fs from "node:fs"

/** `dt version` (also `--version`, `-v`) — works OUTSIDE a workspace: the post-install "did it land?" affordance. */
export async function versionCommand(): Promise<number> {
  const p = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  console.log(`${p.name}@${p.version}`)
  return 0
}
