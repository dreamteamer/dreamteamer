import { recordVerb } from "./lib/recordVerb.ts"

export const setCommand = (args: string[]): Promise<number> => recordVerb("set", args)
