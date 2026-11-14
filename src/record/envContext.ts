import path from "node:path"
import fs from "node:fs"
import { parseEnvValues } from "./parseEnvValues.ts"
import type { EnvContext } from "./types.ts"
import type { Workspace } from "../types.ts"

export function envContext(ws: Workspace): EnvContext {
  const envFile = path.join(ws.root, ".env")
  return {
    env: parseEnvValues(fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : ""),
    workspaceFolder: ws.root,
    declared: ws.pkg.dreamteamer?.vars ?? [],
  }
}
