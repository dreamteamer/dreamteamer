import { fieldVerb } from "./lib/fieldVerb.ts"

export const rmFieldCommand = (args: string[]): Promise<number> => fieldVerb("rm-field", args)
