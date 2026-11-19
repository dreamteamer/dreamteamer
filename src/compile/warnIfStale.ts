import { staleness } from "./staleness.ts"

/** Warn when the compiled runtime is missing or older than its sources; returns what `staleness` found. */
export function warnIfStale(root: string): ReturnType<typeof staleness> {
  const s = staleness(root)
  if (!s.compiled) console.warn(`⚠ ${s.message}`)
  else if (s.stale.length)
    console.warn(`⚠ .dreamteamer is stale (${s.stale.length} source(s) differ) — run \`dreamteamer compile\``)
  return s
}
