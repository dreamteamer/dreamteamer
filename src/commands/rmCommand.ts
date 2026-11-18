import { recordVerb } from "./lib/recordVerb.ts"

export const rmCommand = (args: string[]): Promise<number> => recordVerb("rm", args)
