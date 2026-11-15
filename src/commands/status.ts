import { openWorkspace } from "../openWorkspace.ts"

export async function run(args: string[]): Promise<number> {
  let ws
  try {
    ws = await openWorkspace()
  } catch (e) {
    // `status` is read-only and always answers: a runtime whose extensions refuse to load (two
    // packages claiming one unit, a bad declaration) is reported as the status, exit 0
    console.log(`✖ extensions did not load — ${String(e.message).split("\n")[0]}`)
    console.log(
      "  the setup section cannot be read until that is fixed; records and the compiled runtime are untouched"
    )
    return 0
  }
  const { statusCommand } = await import("../statusCommand.ts")
  return statusCommand(ws, args)
}
