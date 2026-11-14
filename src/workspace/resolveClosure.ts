import { engineVersion } from "../runtime/runtime.ts"
import { indexFolder } from "./indexFolder.ts"
import type { installedModules } from "./installedModules.ts"
import { readSpecManifest } from "./readSpecManifest.ts"
import { resolveNpm } from "./resolveNpm.ts"
import { satisfies } from "./satisfies.ts"
import type { SpecEntry } from "./types.ts"
import { isPathSpec, refuse, splitSpec } from "./versions.ts"

/**
 * Resolve the specs and the closure of their `dreamteamer.dependencies`, and refuse — before npm
 * writes anything — a package that is not a module, an engine floor this engine does not meet, a
 * ring, a version already installed differently, and `provides` conflicts in both directions.
 * Returns the ordered install list (dependencies first) and the names already satisfied.
 */
export function resolveClosure(
  specs: string[],
  {
    installed,
    from = null,
    npm = resolveNpm(),
    cwd = process.cwd(),
    engine = engineVersion(),
  }: {
    installed?: ReturnType<typeof installedModules>
    from?: string | null
    npm?: string | null
    cwd?: string
    engine?: string
  } = {}
): { list: SpecEntry[]; already: string[] } {
  const index = from ? indexFolder(from) : null
  const list: SpecEntry[] = []
  const already: string[] = []
  const seen = new Map<string, SpecEntry>() // name → entry
  // a package an INSTALLED one already provides: present for the walk (never resolved again), and refused
  // the moment it is asked for by name — before any of its dependencies are looked up anywhere
  const providedBy = (name: string): string | null =>
    [...installed].find(([, i]) => (i.manifest?.dreamteamer?.provides ?? []).includes(name))?.[0] ?? null
  const judge = (entry: SpecEntry, askedAs: "spec" | "dependency", stack: string[] = []): void => {
    const m = entry.manifest
    if (!m.dreamteamer || typeof m.dreamteamer !== "object")
      throw refuse(
        `${m.name}@${m.version} is not a dreamteamer module (no dreamteamer key in its package.json)${stack.length ? ` — needed by ${stack.at(-1)}` : ""}`
      )
    const provider = providedBy(m.name)
    if (provider) throw refuse(`${provider} already provides ${m.name} — it is installed; nothing to add`)
    const range = m.dreamteamer.engine
    if (range && satisfies(engine, range) === false)
      throw refuse(
        `${m.name}@${m.version} needs engine "${range}" — this is ${engine}; choose a version: dt install ${m.name}@<version>`
      )
    const here = installed.get(m.name)
    if (here?.linked) throw refuse(`${m.name} is a development link (not pinned) — remove the link to pin a version`)
    if (here && here.version && here.version !== m.version && askedAs === "spec")
      throw refuse(
        `${m.name} is installed at ${here.version}, not ${m.version} — move it on purpose: dt update ${m.name}@${m.version}`
      )
  }
  const walk = (spec: string, stack: string[], askedAs: "spec" | "dependency"): void => {
    // asked for by name and already provided: refuse by name, without reading any manifest
    if (askedAs === "spec" && !isPathSpec(spec, cwd)) {
      const p = providedBy(splitSpec(spec).name)
      if (p) throw refuse(`${p} already provides ${splitSpec(spec).name} — it is installed; nothing to add`)
    }
    const entry = readSpecManifest(spec, { from, index, npm, cwd })
    const name = entry.manifest.name
    if (stack.includes(name))
      throw refuse(`ring in dreamteamer.dependencies: ${[...stack.slice(stack.indexOf(name)), name].join(" → ")}`)
    if (seen.has(name)) {
      // the same module asked for twice at different versions is a conflict, never a silent first-wins
      const prev = seen.get(name).manifest.version
      if (askedAs === "spec" && prev !== entry.manifest.version)
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
    for (const dep of entry.manifest.dreamteamer.dependencies ?? []) {
      if ((installed.has(dep) || providedBy(dep)) && !stack.includes(dep)) continue // present (or composed in): its own closure was judged when it came in
      walk(dep, [...stack, name], "dependency")
    }
    list.push(entry)
  }
  for (const s of specs) walk(s, [], "spec")
  // provides, both ways — against what is installed and within the call itself
  const names = new Set(list.map(e => e.manifest.name))
  for (const e of list) {
    const name = e.manifest.name
    for (const p of e.manifest.dreamteamer.provides ?? []) {
      if (installed.has(p))
        throw refuse(
          `${name} provides ${p}, which is installed — remove ${p} first (npm uninstall ${p}, then dt compile), or keep the small modules`
        )
      if (names.has(p)) throw refuse(`${name} provides ${p} — install one or the other, not both in one call`)
    }
    for (const o of list)
      if (o !== e && (o.manifest.dreamteamer.provides ?? []).includes(name))
        throw refuse(`${o.manifest.name} provides ${name} — install one or the other, not both in one call`)
  }
  return { list, already }
}
