import { initCommand as initWorkspace } from "../init/initCommand.ts"
import { openWorkspace } from "../openWorkspace.ts"
import type { Flags } from "../types.ts"
import { verify } from "./lib/verify.ts"

/** `dt init` runs BEFORE a workspace exists — no findWorkspace. */
export async function initCommand(args: string[]): Promise<number> {
  const flags: Flags = {}
  for (let i = 0; i < args.length; i++)
    if (args[i].startsWith("--")) {
      const [k, v] = args[i].slice(2).split(/=(.*)/s)
      flags[k] = v ?? args[i + 1]
    }
  // boolean flags take no value: a following positional is not theirs
  for (const b of ["no-git", "no-compile", "no-input"]) if (b in flags) flags[b] = true
  return initWorkspace(flags, { open: openWorkspace, argv: args, verify })
}
