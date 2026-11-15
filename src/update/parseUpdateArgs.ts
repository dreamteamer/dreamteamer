/** The `dt update` argv: a target (`name`, `name@version`), `--engine`, `--allow downgrade|nav-reset`, `--from <dir>`, `--no-commit`. */
export function parseUpdateArgs(argv: string[]) {
  const out = {
    name: null as string | null,
    version: null as string | null,
    engine: argv.includes("--engine"),
    allow: new Set<string>(),
    from: null as string | null,
    noCommit: argv.includes("--no-commit"),
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--allow") {
      const k = argv[++i]
      if (k !== "downgrade" && k !== "nav-reset")
        throw new Error(`dt update --allow takes downgrade or nav-reset (got ${JSON.stringify(k)})`)
      out.allow.add(k)
    } else if (a === "--from") out.from = argv[++i] ?? null
    else if (!a.startsWith("--") && !["--allow", "--from"].includes(argv[i - 1])) {
      const at = a.startsWith("@") ? a.indexOf("@", 1) : a.indexOf("@")
      if (at > 0) {
        out.name = a.slice(0, at)
        out.version = a.slice(at + 1)
      } else out.name = a
    }
  }
  return out
}
