import { usage } from "./setup.ts"

const EFFECTS_ALLOWED = ["download", "network", "machine"]

/** `--allow <kind>`, repeated; an unknown kind is a usage error naming the vocabulary. */
export function parseAllow(argv: string[]): Set<string> {
  const allow = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--allow") continue
    const kind = argv[++i]
    if (!EFFECTS_ALLOWED.includes(kind))
      throw usage(
        `--allow takes one of ${EFFECTS_ALLOWED.join(", ")} (got ${JSON.stringify(kind)}); an account step is \`dt setup <unit> --authorize\``
      )
    allow.add(kind)
  }
  return allow
}
