import { compile as compileModel } from "../../compile/compile.ts"
import type { Verb } from "../Verb.ts"

export const compile: Verb = {
  usage: "compile                                  write .dt/AGENTS.md and .dt/model.json",
  options: [],
  run(a) {
    a.none()
    compileModel(a.model).forEach((t) => a.out(`✔ ${t}`))
    return 0
  },
}
