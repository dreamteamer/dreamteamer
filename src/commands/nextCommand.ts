import { recordVerb } from "./lib/recordVerb.ts"

export const nextCommand = (args: string[]): Promise<number> => recordVerb("next", args)
