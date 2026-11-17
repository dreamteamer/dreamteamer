import { slug } from "../lib/slug.ts"

/** a module's id as a record: its package name without the scope, as a slug (`@dreamteamer/rnd` is `rnd`) */
export function moduleId(name: string): string {
  return slug(name.replace(/^@[^/]+\//, ""))
}
