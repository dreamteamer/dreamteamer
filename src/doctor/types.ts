import type { DoctorRow } from "../types.ts"

/** One capability on the board: its rows and the verdict they fold to. */
export type Capability = { name: string; checks: DoctorRow[]; verdict?: "READY" | "DEGRADED" | "UNAVAILABLE" }
