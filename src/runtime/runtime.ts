import fs from "node:fs"
import path from "node:path"
import { normalizeNamespaces } from "../record/normalizeNamespaces.ts"
import { storageOf } from "../record/storageOf.ts"
import { load } from "../record/yaml.ts"
import type { Descriptor, Manifest } from "../types.ts"

export const RUNTIME_DIR = ".dreamteamer"

/**
 * `name@version` of the RUNNING engine — the dev clone or the installed copy, whichever loaded.
 *
 * ⚠ IT LIVES HERE, NOT IN `compile.js`, BECAUSE A LEDGER STAMPS IT. A proof runner writes the engine
 * version onto every ledger row (a per-machine record of what judged what), and reaching back into
 * the compiler for one string closed a runner ↔ `compile` import cycle — function-level and
 * therefore working, right up until someone calls a prove export at compile.js's module scope. The
 * engine's own identity is a fact about the boundary, the same way `RUNTIME_DIR` is: `compile.js`
 * re-exports both names so its existing callers are unchanged.
 *
 * `../package.json` resolves against THIS file's URL, which is `src/`, so it is the engine root's
 * manifest either way — and a failure to read it is `dreamteamer@unknown` rather than a throw,
 * because a version string is never worth crashing a compile or a proof over.
 */
export function engineId(): string {
  try {
    const p = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
    return `${p.name}@${p.version}`
  } catch {
    return "dreamteamer@unknown"
  }
}

/** Bare semver of the running engine — what the manifest's `engine` key and every ledger row carry. */
export function engineVersion(): string {
  return engineId().split("@").pop()
}

/**
 * Runtime kinds compile PROJECTS rather than stages — they have no source folder under a module
 * root, so nothing can be "edited and recompiled" in the usual place. Lives here, in the boundary,
 * because it is a fact about the runtime's SHAPE: the compiler writes them and the record layer has
 * to describe them, and neither half should learn it from the other (the `storage.base` precedent).
 */
export const DERIVED_KINDS = ["modules"]

/**
 * Where a human edits a compiled collection, as one sentence. ONE definition, because there are two
 * consumers who must never drift: the store's refusal (`dt set modules/<id> …`) and the presentation
 * projection the UI reads to explain a disabled button. This repo's own history is the argument —
 * `git log`/`git diff` and the `?sort=` comparator were each hand-copied into the extension and
 * went wrong in both places.
 */
export function sourceHint(d: Descriptor): string {
  const p = storageOf(d).path
  return DERIVED_KINDS.includes(p)
    ? "the source it was projected from (for `modules`, the module's package.json)"
    : `the file under the owning module (modules/<module>/${p}/)`
}

/** One message, two callers with different manners: the store throws it, `check` prints it. */
export const NO_RUNTIME = "no compiled runtime — run `dreamteamer compile` first"

export function runtimeDir(root: string): string {
  return path.join(root, RUNTIME_DIR)
}

export function readManifest(root: string): Manifest | null {
  try {
    return load(fs.readFileSync(path.join(runtimeDir(root), "manifest.yaml"), "utf8"))
  } catch {
    return null
  }
}

/** One message for a runtime compiled from v1 descriptors by an older engine. */
export const STALE_RUNTIME = "the compiled runtime predates descriptor format v2 — run `dreamteamer compile`"

/**
 * The workspace's declared namespaces, longest-first — the closed set every reference is split
 * against. Read off the MANIFEST rather than package.json so the record layer keeps its single
 * dependency on the compiled artifact (the `sourceRoots()` precedent), and so a runtime compiled
 * before namespaces existed answers `[]` instead of throwing.
 */
export function namespaces(root: string): string[] {
  return normalizeNamespaces(readManifest(root)?.namespaces)
}
