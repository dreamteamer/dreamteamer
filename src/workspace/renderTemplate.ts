import os from "node:os"
import type { EnvContext } from "./types.ts"

const SUPPORTED = "supported: ${env:NAME}, ${workspaceFolder}, ${userHome}"

export function renderTemplate(str: string, { env, workspaceFolder, declared }: EnvContext): string {
  return str.replace(/\$\{([A-Za-z]+)(?::([A-Za-z0-9_]*))?\}/g, (whole, ns, arg) => {
    if (arg === undefined) {
      if (ns === "workspaceFolder") return workspaceFolder
      if (ns === "userHome") return os.homedir()
      return whole // un-namespaced ${VAR}: not ours, inert — prose mentions ${…} freely
    }
    if (ns !== "env") throw new Error(`\${${ns}:${arg}} is not a dreamteamer variable — ${SUPPORTED}`)
    if (!arg) throw new Error(`\${env:} needs a key name — ${SUPPORTED}`)
    if (!declared.includes(arg))
      throw new Error(
        `\${env:${arg}}: "${arg}" is not declared in dreamteamer.vars (workspace package.json) — declared: ${declared.join(", ") || "(none)"}`
      )
    // An empty or whitespace-only value is indistinguishable from unset to anyone reading the
    // rendered output — `FILES_FOLDER=` passes `env.has()` and silently renders to '', producing
    // a plausible-looking but wrong path. Same failure, same message: the operator can't tell
    // the two states apart from outside and doesn't care which one it is.
    if (!env.has(arg) || env.get(arg).trim() === "")
      throw new Error(`\${env:${arg}} is declared but has no value in .env on this machine`)
    return env.get(arg)
  })
}
