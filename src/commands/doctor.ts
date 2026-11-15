import { openWorkspace } from "../openWorkspace.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  const [{ doctorCommand }, api] = await Promise.all([import("../doctor/doctorCommand.ts"), import("../api.ts")])
  return doctorCommand(ws, args, api)
}
