import { CONVERTER } from "./consts.ts"

/** The one refusal for a workspace that still holds v1 sources, listing every file. */
export function v1Refusal(files: string[]): string {
  return `${files.length} source(s) are in the v1 descriptor format, which this engine no longer reads:\n${files.map(f => `    - ${f}`).join("\n")}\n  convert the workspace once: ${CONVERTER}\n  then dt compile and dt check — UPDATING.md has the walk.`
}
