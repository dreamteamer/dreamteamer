import { contributedViolations } from "../../api.ts"
import { check } from "../../check/check.ts"
import type { Workspace } from "../../types.ts"

/** `dt check` on a workspace with its extensions' own violations — what init and install verify with. */
export const verify = async (ws: Workspace): Promise<number> => check(ws, { extra: await contributedViolations(ws) })
