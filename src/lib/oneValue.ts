import type { Flags } from "../types.ts"

/**
 * Read a flag that takes exactly ONE value. A repeat arrives as an array, and dropping it on the
 * floor (`typeof v === 'string'` reads an array as absent) would answer the wrong question at exit
 * 0 — so it is named instead, with the line that was typed.
 */
export function oneValue(flags: Flags, key: string): string | undefined {
  const v = flags[key]
  if (Array.isArray(v)) {
    throw new Error(
      `--${key} was given ${v.length} times and takes ONE value: ${v.map(x => `--${key} ${x}`).join(" ")}`
    )
  }
  return typeof v === "string" ? v : undefined
}
