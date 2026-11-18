import { recordVerb } from "./lib/recordVerb.ts"

export const listCommand = (args: string[]): Promise<number> => recordVerb("list", args)
