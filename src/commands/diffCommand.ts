import { recordVerb } from "./lib/recordVerb.ts"

export const diffCommand = (args: string[]): Promise<number> => recordVerb("diff", args)
