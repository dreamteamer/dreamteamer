import { fieldVerb } from "./lib/fieldVerb.ts"

export const run = (args: string[]): Promise<number> => fieldVerb("add-field", args)
