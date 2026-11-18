import { recordVerb } from "./lib/recordVerb.ts"

export const addCommand = (args: string[]): Promise<number> => recordVerb("add", args)
