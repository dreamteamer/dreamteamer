import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { asOptional } from "../lib/asOptional.ts"
import { asStrings } from "../lib/asStrings.ts"
import { DtError } from "../lib/DtError.ts"
import { mapOf } from "../lib/mapOf.ts"

const SUPPORTED = "supported: ${env:NAME}, ${workspaceFolder}, ${userHome}"

/** what a template renders against: this machine's .env values, the workspace, and the names `dreamteamer.vars` declares */
interface EnvContext {
  env: Map<string, string>
  workspaceFolder: string
  declared: string[]
}

/** the values of a .env text, read and never evaluated; a quoted value may span lines */
export function parseEnvValues(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\n]*)$/gm
  for (const m of text.matchAll(re)) {
    const v = m[2].trim()
    out.set(m[1], /^(".*"|'.*')$/s.test(v) ? v.slice(1, -1) : v)
  }
  return out
}

/** the context a workspace's templates render against */
export function envContext(ws: { root: string; pkg?: unknown }): EnvContext {
  const file = join(ws.root, ".env")
  const vars = mapOf(mapOf(ws.pkg).dreamteamer).vars
  const res: EnvContext = {
    env: parseEnvValues(existsSync(file) ? readFileSync(file, "utf8") : ""),
    workspaceFolder: ws.root,
    declared: asOptional(vars, "dreamteamer.vars", asStrings) ?? [],
  }
  return res
}

/**
 * Render `${env:NAME}`, `${workspaceFolder}` and `${userHome}`; a bare `${NAME}` is left as written. A name not in
 * `dreamteamer.vars`, or with no value in .env, is refused.
 */
export function renderTemplate(text: string, ctx: EnvContext): string {
  return text.replace(/\$\{([A-Za-z]+)(?::([A-Za-z0-9_]*))?\}/g, (whole, ns: string, arg: string | undefined) => {
    if (arg === undefined) return ns === "workspaceFolder" ? ctx.workspaceFolder : ns === "userHome" ? homedir() : whole
    if (ns !== "env") throw new DtError(`\${${ns}:${arg}} is not a dreamteamer variable — ${SUPPORTED}`)
    if (!arg) throw new DtError(`\${env:} needs a key name — ${SUPPORTED}`)
    if (!ctx.declared.includes(arg))
      throw new DtError(
        `\${env:${arg}}: "${arg}" is not declared in dreamteamer.vars (workspace package.json) — declared: ${ctx.declared.join(", ") || "(none)"}`,
      )
    const v = ctx.env.get(arg)
    if (v === undefined || !v.trim())
      throw new DtError(`\${env:${arg}} is declared but has no value in .env on this machine`)
    return v
  })
}
