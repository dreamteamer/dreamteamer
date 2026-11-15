import { fieldVerb } from "./lib/fieldVerb.ts"

export const run = (args: string[]): Promise<number> => fieldVerb("rename-field", args)
