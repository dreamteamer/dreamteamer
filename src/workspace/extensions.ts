/**
 * Does a `dreamteamer.disable` list switch off the WHOLE package `name`? An entry names a package by
 * its full name (`@scope/kit`, `probe-kit`) or by its module id — the name with the npm
 * scope stripped (`kit`), which is what every engine message calls a module. Anything else with
 * a slash is `<module>/<entity>`, one entity of a module, and never the package.
 *
 * ⚠ The scoped full name used to be read as `<module>/<entity>` because it contains a slash, and the
 * bare id was compared against the full name — so neither spelling could disable a scoped package.
 * Every extension this project ships is scoped.
 */
export function disablesPackage(disable: unknown[] | null | undefined, name: string): boolean {
  const id = String(name).replace(/^@[^/]+\//, "")
  return (disable ?? []).some(d => isPackageEntry(d) && [name, id].includes((d as string).slice("modules/".length)))
}

/** Is a `dreamteamer.disable` entry a whole module — `modules/<id or package name>` — rather than an
 *  entity, `<kind>/<id>`? The record grammar either way: a module is a record of `modules`. */
export const isPackageEntry = (d: unknown): d is string => typeof d === "string" && d.startsWith("modules/")

/** Is `relFromKind` (a '/'-separated path under the kind folder) inside one of its excluded subtrees? */
export function excludedFromKind(
  kinds: { kind: string; exclude: string[] }[],
  kind: string,
  relFromKind: string
): boolean {
  const k = kinds.find(x => x.kind === kind)
  return !!k && k.exclude.some(e => relFromKind === e || relFromKind.startsWith(`${e}/`))
}
