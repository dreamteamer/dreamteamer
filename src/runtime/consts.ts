export const RUNTIME_DIR = ".dreamteamer"

/**
 * Runtime kinds compile PROJECTS rather than stages — they have no source folder under a module
 * root, so nothing can be "edited and recompiled" in the usual place. Lives here, in the boundary,
 * because it is a fact about the runtime's SHAPE: the compiler writes them and the record layer has
 * to describe them, and neither half should learn it from the other (the `storage.base` precedent).
 */
export const DERIVED_KINDS = ["modules"]

/** One message, two callers with different manners: the store throws it, `check` prints it. */
export const NO_RUNTIME = "no compiled runtime — run `dreamteamer compile` first"

/** One message for a runtime compiled from v1 descriptors by an older engine. */
export const STALE_RUNTIME = "the compiled runtime predates descriptor format v2 — run `dreamteamer compile`"
