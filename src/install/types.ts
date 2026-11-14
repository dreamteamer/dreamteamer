import type { observeState } from "./observeState.ts"

/** One line of `dt install`'s board: `todo` runs, `already` is satisfied, `skip` is not this checkout's to do. */
export type InstallStep = { id: string; label: string; state: "todo" | "already" | "skip"; why?: string }

/** What `dt install` observed about this checkout before planning (`observeState`). */
export type CheckoutState = ReturnType<typeof observeState>
