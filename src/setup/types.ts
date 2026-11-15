import type { SetupAction, SetupCheck, SetupInput, SetupUnit } from "../types.ts"

/** A unit as the driver runs it: the validated unit, its package's folder and the env keys the package declares. */
export interface DrivenUnit extends SetupUnit {
  dir?: string
  declared: Set<string>
}

/** One `--input` flag: `unit` is null for the unscoped `id=value` form. */
export interface InputFlag {
  unit: string | null
  id: string
  value: string
}

/** An input whose value the engine refused (a bad secret-path, two values for one key). */
export interface InputProblem {
  unit: string
  id: string
  reason: string
  required: boolean
  env: string | null
}

/** One unit's line, folded from its checks. */
export interface Folded {
  state: string
  detail: string
  verified: string | null
}

/** An action left for later, and why; an env action's values are replaced by its key names. */
export interface PendingAction extends Omit<SetupAction, "env"> {
  why: string
  env?: SetupAction["env"] | string[]
}

export interface UnitRun {
  checks: SetupCheck[]
  applied: { id: string; changed: string[]; message?: string }[]
  pending: PendingAction[]
  failed: { id: string; message: string }[]
  needs: string[]
}

/** One unit's report from `dt setup` / `dt install`: its folded line, what ran, what is left, what it needs. */
export interface UnitResult extends Folded, Omit<UnitRun, "checks"> {
  id: string
  module: string
  checks?: SetupCheck[]
  problems?: InputProblem[]
}

/** The terminal's prompt and y/n — or a caller's stand-in for them. */
export interface SetupIO {
  prompt: (input: SetupInput, def: unknown) => Promise<unknown>
  ask: (action: SetupAction | PendingAction, kinds: string[]) => Promise<boolean>
}

/** One line of `dt status`'s setup section. */
export interface StatusLine extends Folded {
  package: string | null
  unit: string | null
  grouped?: boolean
  checks: SetupCheck[]
  next: string
}
