import { compile as compileModel } from "../../compile/compile.ts"
import type { Verb } from "../Verb.ts"

export const compile: Verb = {
  usage: "compile                                  write .dt/ and the compiled layout in .dreamteamer/",
  options: [],
  run(a) {
    a.none()
    compileModel(a.model).forEach((t) => a.out(`✔ ${t}`))
    return 0
  },
}
