import * as api from "../api.ts"
import { doctorCommand } from "../doctor/doctorCommand.ts"
import { openWorkspace } from "../openWorkspace.ts"

export async function run(args: string[]): Promise<number> {
  const ws = await openWorkspace()
  return doctorCommand(ws, args, api)
}
