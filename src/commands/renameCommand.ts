import { recordVerb } from "./lib/recordVerb.ts"

export const renameCommand = (args: string[]): Promise<number> => recordVerb("rename", args)
