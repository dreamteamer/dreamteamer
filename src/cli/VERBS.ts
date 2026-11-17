/** each verb, and the options it takes */
export const VERBS = {
  modules: [],
  collections: [],
  list: ["filter", "json"],
  get: ["json"],
  add: ["id"],
  set: [],
  rm: ["force"],
  check: [],
  compile: [],
} as const satisfies Record<string, readonly string[]>

export type Verb = keyof typeof VERBS

/**
 * The verb a command names.
 * Review: `in` also answers for names every object inherits (`constructor`), which then run as `check`, as before;
 * whether to refuse them instead is undecided.
 */
export function isVerb(s: string): s is Verb {
  return s in VERBS
}
