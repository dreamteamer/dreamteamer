import type { Flags } from "../types.ts"
import { META_FLAGS } from "./consts.ts"

export const stripMeta = (flags: Flags): Flags =>
  Object.fromEntries(Object.entries(flags).filter(([k]) => !META_FLAGS.has(k)))
