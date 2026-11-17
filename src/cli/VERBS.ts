import type { Verb } from "./Verb.ts"
import { add } from "./verbs/add.ts"
import { changes } from "./verbs/changes.ts"
import { check } from "./verbs/check.ts"
import { collections } from "./verbs/collections.ts"
import { commit } from "./verbs/commit.ts"
import { compile } from "./verbs/compile.ts"
import { get } from "./verbs/get.ts"
import { list } from "./verbs/list.ts"
import { modules } from "./verbs/modules.ts"
import { next } from "./verbs/next.ts"
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
  next,
  relations,
  changes,
  commit,
  check,
  compile,
} as const satisfies Record<string, Verb>

/** the verb a command names: one of the table's own keys, never a name every object inherits (`constructor`) */
export function isVerb(s: string): s is keyof typeof VERBS {
  return Object.hasOwn(VERBS, s)
}
