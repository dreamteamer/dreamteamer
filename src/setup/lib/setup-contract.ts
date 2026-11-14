import type { SetupAction } from "../../types.ts"

/** Does this action ask the engine to write `.env`? (`env: { KEY: value, … }` on the action — D61.) */
export const isEnvAction = (action: unknown): action is SetupAction & { env: Record<string, unknown> } =>
  !!action && typeof action === "object" && (action as SetupAction).env !== undefined
