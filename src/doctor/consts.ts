import { BEGIN, END, INSTRUCTIONS_BEGIN, INSTRUCTIONS_END } from "../workspace/consts.ts"

/** Both managed blocks as data, for a tool that has to recognise generated text in a user-owned file
 *  (a merge tool resolving a conflict) without importing marker strings from an internal module. The
 *  files carrying them are the manifest's `adapter-blocks`. */
export const MANAGED_BLOCKS: readonly { id: "orientation" | "instructions"; begin: string; end: string }[] =
  Object.freeze([
    Object.freeze({ id: "orientation", begin: BEGIN, end: END }),
    Object.freeze({ id: "instructions", begin: INSTRUCTIONS_BEGIN, end: INSTRUCTIONS_END }),
  ])
