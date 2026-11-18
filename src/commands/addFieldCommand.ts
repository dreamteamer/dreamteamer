import { fieldVerb } from "./lib/fieldVerb.ts"

export const addFieldCommand = (args: string[]): Promise<number> => fieldVerb("add-field", args)
