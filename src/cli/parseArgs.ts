import { DtError } from "../lib/DtError.ts"
import type { Verb } from "./Verb.ts"

/** the options that take no value */
const FLAGS = ["json", "force"]

/** `--name value`, `--name=value`, a bare `--flag`, and `name=value`; the verb's own options are kept apart from fields */
export function parseArgs(name: string, verb: Verb, rest: string[]) {
  const takes = verb.options
  const a: { pos: string[]; opts: Record<string, string[]>; fields: [string, string | undefined][] } = {
    pos: [],
    opts: {},
    fields: [],
  }
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    let key: string
    let value: string | undefined
    if (t.startsWith("--") && t.length > 2) {
      const eq = t.indexOf("=")
      key = eq < 0 ? t.slice(2) : t.slice(2, eq)
      if (FLAGS.includes(key) && takes.includes(key)) {
        if (eq >= 0) throw new DtError(`--${key} takes no value`)
        ;(a.opts[key] ??= []).push("true")
        continue
      }
      value =
        eq >= 0 ? t.slice(eq + 1) : rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[++i] : undefined
    } else if (/^[A-Za-z_][\w.-]*=/.test(t) && verb.fields) {
      key = t.slice(0, t.indexOf("="))
      value = t.slice(t.indexOf("=") + 1)
    } else {
      a.pos.push(t)
      continue
    }
    if (takes.includes(key)) (a.opts[key] ??= []).push(value ?? "true")
    else if (verb.fields) a.fields.push([key, value])
    else
      throw new DtError(
        `${name} does not take --${key}${takes.length ? ` — it takes ${takes.map((o) => "--" + o).join(", ")}` : ""}`,
      )
  }
  return a
}
