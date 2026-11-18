import { recordVerb } from "./lib/recordVerb.ts"

export const revertCommand = (args: string[]): Promise<number> => recordVerb("revert", args)
