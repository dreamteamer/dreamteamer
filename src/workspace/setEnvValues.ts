import { EnvRefusal } from "./env-write.ts"
import { envSpans } from "./envSpans.ts"

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/

/** The token written for `value`: plain when nothing in it needs quoting (a backslash reads back as
 *  itself unquoted — a Windows path), else double-quoted. Inside double quotes the reader treats `\x` as
 *  one unit, so a backslash there could swallow the closing quote: refused. */
function token(key: string, value: string, preferQuoted: boolean): string {
  const plain = /^[^\s#"']*$/.test(value) && value === value.trim() && !(preferQuoted && !value.includes("\\"))
  if (plain) return value
  if (value.includes("\\"))
    throw new EnvRefusal("value", `${key}: a value with characters this action does not write — set it by hand`)
  return `"${value}"`
}

/**
 * `.env` text with every key of `values` set, every other byte kept: a present key's value span is
 * replaced in place (its quoting kept when it was double-quoted); an absent key is appended as its
 * own line. `changed` lists the keys whose value differs from what the file held.
 * Refuses, by code: `twice` (a key assigned more than once — which assignment wins is the reader's
 * accident, so neither is rewritten) and `value` (a value holding `"` or NUL — the reader does not
 * unescape, so such a value cannot read back as written).
 */
export function setEnvValues(text: string, values: Record<string, unknown>): { text: string; changed: string[] } {
  let out = String(text)
  // a byte-order mark stays where it is; envSpans scans past it (the engine's reader of the unit's
  // environment, unitEnv, skips it too — held-out he1)
  const changed: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (!ENV_KEY.test(key)) throw new EnvRefusal("key", `${key} is not an environment key`)
    if (typeof value !== "string") throw new EnvRefusal("value", `${key}: a value that is not a string`)
    const found = envSpans(out).filter(s => s.key === key)
    if (found.length > 1)
      throw new EnvRefusal("twice", `${key} is assigned more than once in .env — resolve that by hand first`)
    // a value the file already holds is done, whatever it holds: one a person set by hand after a refusal
    // is never refused again
    if (found.length === 1 && found[0].value === value) continue
    // a `"` the reader does not unescape; `$`, a backtick or a carriage return a shell that sources .env
    // would expand or split; NUL — refused, so what is written reads back as written everywhere
    if (/["$`\r\0]/.test(value))
      throw new EnvRefusal("value", `${key}: a value with characters this action does not write — set it by hand`)
    if (found.length === 1) {
      const s = found[0]
      out = out.slice(0, s.start) + token(key, value, s.quoted === '"') + out.slice(s.end)
    } else {
      const nl = out.includes("\r\n") ? "\r\n" : "\n"
      out = `${out}${out && !out.endsWith("\n") ? nl : ""}${key}=${token(key, value, false)}${nl}`
    }
    changed.push(key)
  }
  return { text: out, changed }
}
