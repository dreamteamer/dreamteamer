import { RESERVED_NAMESPACES } from "./namespace.ts"

/** One segment of a namespace or collection name: the id-safe alphabet the rest of the engine uses. */
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Everything wrong with a declared list, as sentences — or `[]`. `collectionNames` is every compiled
 * collection's qualified name, which is what makes the collision check possible at all.
 *
 * compile calls this and fails on a non-empty result. It is a separate function from the compiler so
 * the rules can be tested directly, and so the error text lives beside the semantics it protects.
 */
export function namespaceProblems(namespaces: string[], collectionNames: Iterable<string> = []): string[] {
  const problems: string[] = []
  const names = new Set(collectionNames)
  for (const ns of namespaces) {
    const segments = ns.split("/")
    for (const seg of segments) {
      if (RESERVED_NAMESPACES.has(seg)) {
        problems.push(
          `namespace "${ns}": "${seg}" is reserved — the default namespace is the EMPTY prefix, so a collection in it is spelled \`tasks\`, never \`default/tasks\`.`
        )
      } else if (!SEGMENT.test(seg)) {
        problems.push(
          `namespace "${ns}": segment "${seg}" must be lowercase alphanumeric with single hyphens (it becomes a folder name and part of every reference).`
        )
      }
    }
    // The collision that makes a slash-delimited namespace dangerous: with BOTH a namespace
    // `health` and a collection `health`, the reference `health/doctors/dana-levi` is a record of
    // collection `health/doctors` AND a record of collection `health` with the nested id
    // `doctors/dana-levi`. Longest-match would silently pick the first and make the second
    // unreferenceable. Refused up front instead.
    if (names.has(ns)) {
      problems.push(
        `namespace "${ns}" collides with the collection of the same name — a reference like "${ns}/x/y" would be ambiguous. Rename one.`
      )
    }
  }
  return problems
}
