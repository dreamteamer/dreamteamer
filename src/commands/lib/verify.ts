import type { Workspace } from "../../types.ts"

/** `dt check` on a workspace with its extensions' own violations — what init and install verify with. */
export const verify = async (ws: Workspace): Promise<number> => {
  const [{ check }, api] = await Promise.all([import("../../check/check.ts"), import("../../api.ts")])
  return check(ws, { extra: await api.contributedViolations(ws) })
}
