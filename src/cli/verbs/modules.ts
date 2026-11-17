import type { Verb } from "../Verb.ts"

export const modules: Verb = {
  usage: "modules                                  the modules this workspace has",
  options: [],
  run(a) {
    a.none()
    a.model.modules.forEach((t) =>
      a.out(
        `${t.name}@${t.version} [${t.origin}]${t.unsupported.length ? ` — not acted on here: ${t.unsupported.join(", ")}` : ""}`,
      ),
    )
    return 0
  },
}
