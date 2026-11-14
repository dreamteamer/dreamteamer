import type { SetupAction } from "../types.ts"

export const SETUP_VERSION = 1

export const INPUT_KINDS = ["string", "path", "rows", "secret-path"]

export const CHECK_STATUSES = ["ready", "configured", "unverified", "missing", "blocked"]

export const ENV_KEY = /^[A-Z][A-Z0-9_]*$/

/** Does this action ask the engine to write `.env`? (`env: { KEY: value, … }` on the action — D61.) */
export const isEnvAction = (action: unknown): action is SetupAction & { env: Record<string, unknown> } =>
  !!action && typeof action === "object" && (action as SetupAction).env !== undefined
