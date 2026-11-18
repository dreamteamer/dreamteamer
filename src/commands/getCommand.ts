import { recordVerb } from "./lib/recordVerb.ts"

export const getCommand = (args: string[]): Promise<number> => recordVerb("get", args)
