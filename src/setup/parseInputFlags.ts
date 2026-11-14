import { usage } from "./setup.ts"
import type { InputFlag } from "./types.ts"

// ---- pure ---------------------------------------------------------------------------------------

/** `--input id=value` and `--input unit.id=value`, repeated; the value may itself hold `=`. */
export function parseInputFlags(argv: string[]): InputFlag[] {
  const out: InputFlag[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--input") continue
    const raw = argv[++i]
    const eq = raw?.indexOf("=") ?? -1
    if (eq < 1) throw usage("--input takes id=value (or unit.id=value)")
    const key = raw.slice(0, eq),
      value = raw.slice(eq + 1)
    const dot = key.indexOf(".")
    out.push(dot > 0 ? { unit: key.slice(0, dot), id: key.slice(dot + 1), value } : { unit: null, id: key, value })
  }
  return out
}
