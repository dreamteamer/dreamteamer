import { VIEW_LIST_OPTIONS } from "./consts.ts"

/**
 * `--filter '{"status":{"_eq":"seen"}}'` style flags, plus dotted `display.list.sort=-date` positionals. The
 * KEY is passed because the value's shape depends on it: only the key says whether a comma is a
 * separator or a character.
 */
export function parseViewValue(raw: string | boolean, key: string): unknown {
  if (typeof raw !== "string") return raw
  const t = raw.trim()
  if (t === "true") return true
  if (t === "false") return false
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t)
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t)
    } catch {
      throw new Error(`not valid JSON: ${t}`)
    }
  }
  // ⚠ A QUOTED value is a LITERAL string, and `display.list.sort='""'` is the whole reason the branch
  // exists: `sort: ''` is what the surface requires to round-trip "unsorted" (omit it and the
  // ordering silently reverts to a fallback on the next load), and the dotted grammar could not
  // express it — an empty value UNSETS, by the same convention `dt set` has for a record field.
  // So the quoting is the operator saying "the empty string IS the value"; `assignViewValue`
  // carries that through to `assignPath`.
  if (t.startsWith('"')) {
    try {
      const s = JSON.parse(t)
      if (typeof s === "string") return s
    } catch {
      /* one message for every malformed quoting, below */
    }
    throw new Error(`not a quoted string: ${t} — a literal is written like '"-date"' (and '""' for the empty one)`)
  }
  // An empty value falls through to assignPath, which UNSETS the key — a `columns=` that wrote
  // `columns: []` would be a configured-to-show-nothing view, not a removed setting.
  if (t !== "" && VIEW_LIST_OPTIONS.has(key))
    return t
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  return raw
}
