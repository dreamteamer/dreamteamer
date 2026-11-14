import type { SetupCheck } from "../types.ts"
import type { Folded } from "../workspace/types.ts"

/** One line of `dt status`'s setup section. */
export type StatusLine = Folded & {
  package: string | null
  unit: string | null
  grouped?: boolean
  checks: SetupCheck[]
  next: string
}
