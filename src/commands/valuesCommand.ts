import { recordVerb } from "./lib/recordVerb.ts"

export const valuesCommand = (args: string[]): Promise<number> => recordVerb("values", args)
