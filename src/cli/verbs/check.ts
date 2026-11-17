import { check as checkAll } from "../../store/check.ts"
import type { Severity } from "../../types/Issue.ts"
import type { Verb } from "../Verb.ts"

const MARKS = { error: "✖", warning: "⚠" } as const satisfies Record<Severity, string>

export const check: Verb = {
  usage: "check                                    validate every record; changes nothing",
  options: [],
  run(a) {
    a.none()
    const { records, issues } = checkAll(a.model)
    issues.forEach((t) => a.out(`${MARKS[t.severity]} ${t.where}: ${t.message}`))
    const errors = issues.filter((t) => t.severity === "error").length
    const counts = `${Object.keys(a.model.collections).length} collections · ${a.model.modules.length} modules`
    a.out(`${records} records · ${counts} · ${errors} errors · ${issues.length - errors} warnings`)
    return errors ? 1 : 0
  },
}
