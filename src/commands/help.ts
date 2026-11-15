import { emit } from "../lib/emit.ts"
import { openWorkspace } from "../openWorkspace.ts"
import type { Workspace } from "../types.ts"
import { USAGE } from "../usage.ts"

/** `dt help` works OUTSIDE a workspace too — a person who just ran `npm i -g dreamteamer` on a bare
 *  machine has nothing else to read. Inside one, each installed extension's own usage follows the engine's. */
export async function run(): Promise<number> {
  let ws = null
  try {
    ws = await openWorkspace()
  } catch {
    /* no workspace, or an extension that will not load — plain help */
  }
  emit(USAGE + extensionUsage(ws))
  return 0
}

/** Each installed extension's usage block, headed by its package — '' outside a workspace. */
function extensionUsage(ws: Workspace | null) {
  const blocks = (ws?.extensions ?? [])
    .filter(e => Object.keys(e.commands).length)
    .map(
      e =>
        `\n${e.name}@${e.version}:\n${Object.entries(e.commands)
          .map(([verb, c]) => (c.usage ?? `  ${verb}`).replace(/\s+$/, ""))
          .join("\n")}`
    )
  return blocks.length ? `\ninstalled extensions:${blocks.join("\n")}` : ""
}
