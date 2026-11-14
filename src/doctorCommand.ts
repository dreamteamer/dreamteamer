import { doctorBoard } from "./doctor/doctorBoard.ts"
import { renderBoard } from "./doctor/renderBoard.ts"
import { emit } from "./record/emit.ts"
import type { Workspace } from "./types.ts"

export async function doctorCommand(ws: Workspace, rest: string[], dt: typeof import("./api.ts")): Promise<number> {
  const caps = await doctorBoard(ws, dt)
  if (rest.includes("--json"))
    emit(JSON.stringify({ workspace: { root: ws.root, name: ws.pkg?.name ?? null }, capabilities: caps }, null, 2))
  else console.log(renderBoard(caps))
  return rest.includes("--strict") && caps.some(c => c.verdict === "UNAVAILABLE") ? 1 : 0
}
