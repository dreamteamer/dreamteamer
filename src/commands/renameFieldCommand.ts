import { fieldVerb } from "./lib/fieldVerb.ts"

export const renameFieldCommand = (args: string[]): Promise<number> => fieldVerb("rename-field", args)
