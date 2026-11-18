import * as api from "../api.ts"
import { openWorkspace } from "../openWorkspace.ts"
import { setupCommand } from "../setup/setupCommand.ts"

/** `dt setup [<unit>] …` — the generic driver of the units installed modules declare (src/setup/):
 *  inputs, consent per effect, inspect → plan → apply, the receipt. The engine names no module. */
export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  return setupCommand(ws, args, { api })
}
