import { fieldVerb } from "./lib/fieldVerb.ts"

export const setFieldCommand = (args: string[]): Promise<number> => fieldVerb("set-field", args)
