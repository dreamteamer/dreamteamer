import { singularOf } from "./descriptor.ts"
import type { Descriptors } from "../types.ts"

// The words a collection answers to on the command line: its declared name and its `singular`
// (compile stamps one on every descriptor — derived by inflection, authorable where inflection is
// wrong — and refuses two collections whose words collide). `dt add task …` and `dt add tasks …`
// are the same call. ⚠ TYPED INPUT ONLY: a reference VALUE inside a record (`tasks/kickoff`) is
// parsed by namespace.js's parseRef against declared names and never learns the singular, so
// `task/kickoff` in a field stays the dangling reference `check` reports it as.
export function* words(descriptors: Descriptors): Generator<[word: string, name: string]> {
  for (const [name, d] of descriptors) {
    yield [name, name]
    const word = singularOf(d)
    if (word && word !== name) yield [word, name]
  }
}

/** The declared collection a typed word names — the name itself or its singular — else null. */
export function canonicalCollection(descriptors: Descriptors, word: string): string | null {
  if (descriptors.has(word)) return word
  for (const [w, name] of words(descriptors)) if (w === word) return name
  return null
}
