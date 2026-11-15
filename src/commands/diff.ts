import { recordVerb } from "./lib/recordVerb.ts"

export const run = (args: string[]): Promise<number> => recordVerb("diff", args)
