import type { Verb } from "../Verb.ts"

export const collections: Verb = {
  usage: "collections                              the collections they define",
  options: [],
  run(a) {
    a.none()
    Object.values(a.model.collections).forEach((t) =>
      a.out(`${t.name} (${t.module}) — ${Object.keys(t.fields).length} fields`),
    )
    return 0
  },
}
