import { slug } from "./slug.ts"

/** a name as a slug, or — when nothing in it slugs — the released engine's hash of it (`x` and seven base-36 digits) */
export function slugOrHash(s: string): string {
  const out = slug(s)
  if (out) return out
  let h = 0
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return "x" + h.toString(36).padStart(7, "0")
}
