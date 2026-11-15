import { openWorkspace } from "../openWorkspace.ts"

/** `dt setup [<unit>] …` — the generic driver of the units installed modules declare (src/setup/):
 *  inputs, consent per effect, inspect → plan → apply, the receipt. The engine names no module. */
export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const [{ setupCommand }, api] = await Promise.all([import("../setup/setupCommand.ts"), import("../api.ts")])
  return setupCommand(ws, args, { api })
}
