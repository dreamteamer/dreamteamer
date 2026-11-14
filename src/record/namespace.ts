import { singular } from "./singular.ts"

/** Never a namespace: it would give the default namespace a second, prefixed spelling. */
export const RESERVED_NAMESPACES = new Set(["default"])

/**
 * The declared namespace a qualified collection name sits in, or `''` for the default namespace.
 * Matched against the declared list rather than by cutting at the last slash, because a collection
 * name is only namespaced if its prefix was actually declared — see `unqualifiedProblems`.
 */
export function namespaceOf(qualified: string, namespaces: string[]): string {
  for (const ns of namespaces) if (qualified.startsWith(ns + "/")) return ns
  return ""
}

/** The bare collection name inside its namespace: `health/doctors` → `doctors`. */
export function baseNameOf(qualified: string, namespaces: string[]): string {
  const ns = namespaceOf(qualified, namespaces)
  return ns ? qualified.slice(ns.length + 1) : qualified
}

/**
 * A collection name in the singular — what one RECORD of it is called: `doctors` → `doctor`,
 * `stories` → `story`, `boxes` → `box`, `analyses` → `analysis`, `series` → `series`. Only the last
 * hyphenated word inflects (`meta-analyses` → `meta-analysis`). A name that is not a plural comes back
 * unchanged, which is what `inflects` reports, so compile can say so.
 *
 * Shared by three subsystems in different layers — compile derives an absent `singular` and
 * `storage.suffix` from it, `collections add` writes it into a new descriptor, `rename-collection`
 * asks whether a suffix was derived — so there is exactly one spelling of the rule.
 */
export const INVARIANT = new Set(["series", "species", "news"])

/** Whether `singular(name)` found a plural to inflect. */
export const inflects = (name: string): boolean =>
  singular(name) !== name || INVARIANT.has(name.slice(name.lastIndexOf("-") + 1))

/**
 * The folder a collection's records belong in, workspace-relative and WITHOUT any module prefix
 * (compile adds that for an `owns-data` module). The namespace becomes real directory nesting, which
 * is the point: `health/doctors` lands in `data/health/doctors/` rather than beside `data/tasks/`.
 */
export function defaultStoragePath(qualified: string, namespaces: string[], dataPath = "data"): string {
  const ns = namespaceOf(qualified, namespaces)
  const base = ns ? qualified.slice(ns.length + 1) : qualified
  return ns ? `${dataPath}/${ns}/${base}` : `${dataPath}/${base}`
}

/** How a command id is typed: `/<id>`, with a namespace folder spelled as claude-code spells it —
 *  `rnd/design` is `/rnd:design`. One rule for the orientation block, the bindings section, the
 *  commands index and `dt next`, so what a session reads is what it types. */
export const slash = (id: string): string => `/${String(id).replace(/\//g, ":")}`
