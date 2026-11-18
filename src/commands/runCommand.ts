import { findWorkspace } from "../workspace/findWorkspace.ts"
import { runModuleScript } from "../modules/runModuleScript.ts"

/**
 * `dt run <module> [<script> [<arg>…]]`. Opens the workspace WITHOUT activating extensions: a script is
 * the module's own process, and the verb's arguments are the script's, so none of them is checked here.
 */
export async function runCommand(args: string[]): Promise<number> {
  return runModuleScript(findWorkspace(), args)
}
