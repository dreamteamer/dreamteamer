import { namespaceOf } from "./namespace.ts"

/**
 * A collection name carrying a slash whose prefix is NOT declared, which is the silent-failure this
 * whole module exists to prevent: every reference to it would split at the first slash, name a
 * collection that does not exist, and dangle. Returns problems as sentences, or `[]`.
 */
export function unqualifiedProblems(collectionNames: Iterable<string>, namespaces: string[]): string[] {
  const problems = []
  for (const name of collectionNames) {
    if (!name.includes("/")) continue
    if (namespaceOf(name, namespaces)) continue
    const guess = name.slice(0, name.lastIndexOf("/"))
    problems.push(
      `collection "${name}" is namespaced, but "${guess}" is not declared — add it to \`dreamteamer.namespaces\` in package.json, or every reference to this collection will split at the first slash and dangle.`
    )
  }
  return problems
}
