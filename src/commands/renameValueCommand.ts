import { fieldVerb } from "./lib/fieldVerb.ts"

export const renameValueCommand = (args: string[]): Promise<number> => fieldVerb("rename-value", args)
