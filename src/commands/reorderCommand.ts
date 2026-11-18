import { recordVerb } from "./lib/recordVerb.ts"

export const reorderCommand = (args: string[]): Promise<number> => recordVerb("reorder", args)
