import { load } from "../../lib/yaml.ts"
import type { Entry } from "../../types.ts"
import { flat } from "./harnessMarkers.ts"
import type { EntryDoc, ModuleRow } from "./types.ts"

/** module id -> title / description / namespaces / source path, plus the skills and commands whose
 *  SOURCE lives under that path — read from the module records compile projected, never from
 *  package.json again. A skill or command belongs to the module with the longest source-path prefix;
 *  the root layout (`path: .`) is the empty prefix and so matches last. */
export function buildModulesIndex(entries: Map<string, Entry>): ModuleRow[] {
  const mods: ModuleRow[] = []
  for (const [rt, e] of entries) {
    const m = /^modules\/(.+)\.module\.yaml$/.exec(rt)
    if (!m) continue
    let d: EntryDoc = {}
    try {
      d = load<EntryDoc | null>(e.bytes.toString("utf8")) ?? {}
    } catch {
      /* unparseable record */
    }
    const p = !d.path || d.path === "." ? "" : `${d.path}/`
    mods.push({
      id: m[1],
      title: d.title ?? m[1],
      description: flat(d.description),
      namespaces: d.namespaces ?? [],
      path: p,
      bin: d.bin ?? [],
      skills: [],
      commands: [],
    })
  }
  mods.sort((a, b) => b.path.length - a.path.length) // longest prefix first
  for (const [rt, e] of entries) {
    const kind = /^skills\/([^/]+)\/SKILL\.md$/.exec(rt)
      ? "skills"
      : /^commands\/(.+)\.command\.md$/.exec(rt)
        ? "commands"
        : null
    if (!kind) continue
    const src = e.sources?.[0]?.path ?? ""
    const owner = mods.find(mod => src.startsWith(mod.path))
    if (owner)
      owner[kind].push(
        kind === "skills" ? rt.split("/")[1] : rt.slice("commands/".length).replace(/\.command\.md$/, "")
      )
  }
  for (const mod of mods) {
    mod.skills.sort()
    mod.commands.sort()
  }
  return mods
}
