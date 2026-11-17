import type { Verb } from "./Verb.ts"
import { add } from "./verbs/add.ts"
import { check } from "./verbs/check.ts"
import { collections } from "./verbs/collections.ts"
import { compile } from "./verbs/compile.ts"
import { get } from "./verbs/get.ts"
import { list } from "./verbs/list.ts"
import { modules } from "./verbs/modules.ts"
import { relations } from "./verbs/relations.ts"
import { rm } from "./verbs/rm.ts"
import { set } from "./verbs/set.ts"

/** every verb, in the order the verb list prints them; a new verb is a file in verbs/ and a line here */
export const VERBS = {
  modules,
  collections,
  list,
  get,
  add,
  set,
  rm,
  relations,
  check,
  compile,
} as const satisfies Record<string, Verb>

/**
 * The verb a command names.
 * Review: `in` also answers for names every object inherits (`constructor`), which then run as `check`, as before;
 * whether to refuse them instead is undecided.
 */
export function isVerb(s: string): s is keyof typeof VERBS {
  return s in VERBS
}
