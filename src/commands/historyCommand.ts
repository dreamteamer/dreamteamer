import { recordVerb } from "./lib/recordVerb.ts"

export const historyCommand = (args: string[]): Promise<number> => recordVerb("history", args)
