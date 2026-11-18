import { usage } from "./setup.ts"

const EFFECTS_ALLOWED = ["download", "network", "machine"]

/**
 * `--allow <kind>`, repeated; an unknown kind is a usage error naming the vocabulary. `also` adds kinds
 * a verb takes beyond the setup effects (`dt install`'s `nav-reset`) — the caller removes them before a
 * unit sees the set, and `dt setup` passes none.
 */
export function parseAllow(argv: string[], { also = [] }: { also?: string[] } = {}): Set<string> {
  const allow = new Set<string>()
  const kinds = [...EFFECTS_ALLOWED, ...also]
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--allow") continue
    const kind = argv[++i]
    if (!kinds.includes(kind))
      throw usage(
        `--allow takes one of ${kinds.join(", ")} (got ${JSON.stringify(kind)}); an account step is \`dt setup <unit> --authorize\``
      )
    allow.add(kind)
  }
  return allow
}
