import type { Flags } from "../types.ts"

/**
 * `--flag value`, `--flag=value`, a bare `--flag` (true), and positionals.
 *
 * ⚠ A REPEATED flag PROMOTES TO AN ARRAY; it does not overwrite. `dt add c --tags a --tags b`
 * assigned twice and kept `b`, so the first value never reached disk and nothing said so — the
 * shape of every silent-wrong-answer bug this CLI has had. The promotion is the only honest parse,
 * because "the operator typed it twice" is a fact the parser cannot interpret on its own.
 *
 * Every consumer of a flag therefore owes an answer to "what does a repeat MEAN here", and there
 * are exactly three: it is one ELEMENT of an array field (`coerceArrays`), it is one more
 * conjunctive CONDITION (`--filter`, in list), or the flag holds one value and a repeat is a
 * MISTAKE (`oneValue`, and the view writer). Silence is not one of them.
 */
export function parseArgs(args: string[]): { flags: Record<string, string | boolean | string[]>; pos: string[] } {
  const flags: Flags = {}
  const pos: string[] = []
  const put = (k: string, v: string | true): void => {
    // a repeat promotes to a list; a bare repeat keeps its `true` in the list, as it always has
    flags[k] = k in flags ? (([] as unknown[]).concat(flags[k], v) as string[]) : v
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq > -1) put(a.slice(2, eq), a.slice(eq + 1))
      else if (i + 1 < args.length && !args[i + 1].startsWith("--")) put(a.slice(2), args[++i])
      else put(a.slice(2), true)
    } else pos.push(a)
  }
  return { flags, pos }
}
