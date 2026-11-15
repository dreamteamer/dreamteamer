import type { PackageJson } from "../types.ts"
import type { observeState } from "./observeState.ts"

/** One line of `dt install`'s board: `todo` runs, `already` is satisfied, `skip` is not this checkout's to do. */
export interface InstallStep {
  id: string
  label: string
  state: "todo" | "already" | "skip"
  why?: string
}

/** What `dt install` observed about this checkout before planning (`observeState`). */
export type CheckoutState = ReturnType<typeof observeState>

/** A package spec read to its manifest: a local folder (linked), a tarball, or a registry version. */
export interface SpecEntry {
  kind: "folder" | "tarball" | "registry"
  spec: string
  manifest: PackageJson
}

export type FolderIndex = Map<string, { version: string; file: string; manifest: PackageJson }[]>

/** `hooks.afterNpm` is a test seam the CLI never sets: an interruption between npm and compile */
export interface InstallHooks {
  afterNpm?: () => void | Promise<void>
}
