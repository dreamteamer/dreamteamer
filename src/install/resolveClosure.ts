import { engineVersion } from "../runtime/runtime.ts"
import { indexFolder } from "./indexFolder.ts"
import type { installedModules } from "./installedModules.ts"
import { readSpecManifest } from "./readSpecManifest.ts"
import { resolveNpm } from "../lib/npm/resolveNpm.ts"
import { satisfies } from "../lib/npm/satisfies.ts"
import type { SpecEntry } from "./types.ts"
import { refuse } from "./versions.ts"

/** How a package entered the walk: named on the command line, a dependency, or a preset's member. */
type AskedAs = "spec" | "dependency" | "member"

/**
 * Resolve the specs and the closure of their `dreamteamer.dependencies` and, for a MODULE PRESET, its
 * members at their pins (`dreamteamer.preset`, CR-dt-008), and refuse — before npm writes anything — a
 * package that is not a module, an engine floor this engine does not meet, a ring, and a version
 * already installed differently. Returns the ordered install list (members and dependencies first,
 * the preset itself after them) and the names already satisfied. `skipMembers` names members the
 * walk leaves out (`dt update` passes the ones the operator removed on purpose).
 */
export function resolveClosure(
  specs: string[],
  {
    installed,
    from = null,
    npm = resolveNpm(),
    cwd = process.cwd(),
    engine = engineVersion(),
    skipMembers = new Set(),
  }: {
    installed?: ReturnType<typeof installedModules>
    from?: string | null
    npm?: string | null
    cwd?: string
    engine?: string
    skipMembers?: Set<string>
  } = {}
): { list: SpecEntry[]; already: string[] } {
  const index = from ? indexFolder(from) : null
  const list: SpecEntry[] = []
  const already: string[] = []
  const seen = new Map<string, SpecEntry>() // name → entry
  const judge = (entry: SpecEntry, askedAs: AskedAs, stack: string[] = []): void => {
    const m = entry.manifest
    if (!m.dreamteamer || typeof m.dreamteamer !== "object")
      throw refuse(
        `${m.name}@${m.version} is not a dreamteamer module (no dreamteamer key in its package.json)${stack.length ? ` — needed by ${stack.at(-1)}` : ""}`
      )
    const range = m.dreamteamer.engine
    if (range && satisfies(engine, range) === false)
      throw refuse(
        `${m.name}@${m.version} needs engine "${range}" — this is ${engine}; choose a version: dt install ${m.name}@<version>`
      )
    const here = installed.get(m.name)
    if (here?.linked) throw refuse(`${m.name} is a development link (not pinned) — remove the link to pin a version`)
    if (here && here.version && here.version !== m.version && (askedAs === "spec" || askedAs === "member"))
      throw refuse(
        `${m.name} is installed at ${here.version}, not ${m.version} — move it on purpose: dt update ${m.name}@${m.version}`
      )
  }
  const walk = (spec: string, stack: string[], askedAs: AskedAs): void => {
    const entry = readSpecManifest(spec, { from, index, npm, cwd })
    const name = entry.manifest.name
    if (stack.includes(name))
      throw refuse(
        `ring in dreamteamer.dependencies or preset: ${[...stack.slice(stack.indexOf(name)), name].join(" → ")}`
      )
    if (seen.has(name)) {
      // the same module asked for twice at different versions is a conflict, never a silent first-wins
      const prev = seen.get(name).manifest.version
      if ((askedAs === "spec" || askedAs === "member") && prev !== entry.manifest.version)
        throw refuse(`${name} is asked for at ${prev} and at ${entry.manifest.version} — one version per call`)
      return
    }
    judge(entry, askedAs, stack)
    const here = installed.get(name)
    if (here && here.version === entry.manifest.version) {
      already.push(name)
      seen.set(name, entry)
      return
    }
    seen.set(name, entry)
    // a module preset's members first, each at its pin, a nested preset recursing the same way
    for (const [member, version] of Object.entries(entry.manifest.dreamteamer.preset ?? {})) {
      if (skipMembers.has(member)) continue
      walk(`${member}@${version}`, [...stack, name], "member")
    }
    for (const dep of entry.manifest.dreamteamer.dependencies ?? []) {
      if (installed.has(dep) && !stack.includes(dep)) continue // present: its own closure was judged when it came in
      walk(dep, [...stack, name], "dependency")
    }
    list.push(entry)
  }
  for (const s of specs) walk(s, [], "spec")
  return { list, already }
}
