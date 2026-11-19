import { doctorBoard } from "../doctor/doctorBoard.ts"
import { renderBoard } from "../doctor/renderBoard.ts"
import { emit } from "../lib/emit.ts"
import * as api from "../api.ts"
import { openWorkspace } from "../openWorkspace.ts"

export async function doctorCommand(rest: string[]): Promise<number> {
  const ws = await openWorkspace()
  const caps = await doctorBoard(ws, api)
  if (rest.includes("--json"))
    emit(JSON.stringify({ workspace: { root: ws.root, name: ws.pkg?.name ?? null }, capabilities: caps }, null, 2))
  else console.log(renderBoard(caps))
  return rest.includes("--strict") && caps.some(c => c.verdict === "UNAVAILABLE") ? 1 : 0
}
