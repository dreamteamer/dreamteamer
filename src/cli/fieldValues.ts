import { parse } from "yaml"
import { DtError } from "../lib/DtError.ts"
import { messageOf } from "../lib/messageOf.ts"
import { stamp } from "../lib/stamp.ts"
import type { Collection } from "../types/Collection.ts"
import type { Field } from "../types/Field.ts"

const UNQUALIFIED = ["string", "markdown", "url", "email", "date", "datetime", "position", "reference"]

/** one value typed on the command line, converted by the declared type of its field */
function convert(type: Field["type"], raw: string, name: string): unknown {
  if (type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw
  if (type === "integer" || type === "number") return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
  // a date and time typed without seconds or without a zone is completed, the zone being this machine's on that day
  if (type === "datetime") {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?([Zz]|[+-]\d{2}(?::?\d{2})?)?$/.exec(raw)
    if (m) return `${m[1]}T${m[2]}${m[3] ?? ":00"}${m[4] ?? stamp(new Date(`${m[1]}T${m[2]}:00`)).slice(19)}`
  }
  if (type === "object" || type === "map") {
    try {
      return parse(raw)
    } catch (e) {
      throw new DtError(
        `${name}: a map is written as YAML or JSON, such as '{city: Paris}' — ${messageOf(e).split("\n")[0]}`,
      )
    }
  }
  // a bare id on a field that points at one collection is qualified for you
  if (typeof type === "string" && !UNQUALIFIED.includes(type) && !raw.startsWith(type + "/")) return `${type}/${raw}`
  return raw
}

/** the fields given on the command line, each converted by its declared type; `null` means "clear this field" */
export function fieldValues(c: Collection, given: [string, string | undefined][]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [typed, raw] of given) {
    const name = c.fields[typed] || typed === "created" ? typed : typed.replace(/-/g, "_")
    const f: Field | undefined = name === "created" && !c.fields.created ? { type: "datetime" } : c.fields[name]
    if (!f) {
      const near = Object.keys(c.fields).filter((t) => t.startsWith(typed.slice(0, 3)) || typed.startsWith(t))
      const lead = near.length ? `did you mean ${near.join(" or ")}? Its` : "its"
      throw new DtError(`${c.name} has no field ${typed} — ${lead} fields are ${Object.keys(c.fields).join(", ")}`)
    }
    if (raw === undefined && f.type !== "boolean") throw new DtError(`--${typed} needs a value`)
    const nested = f.type === "object" || f.type === "map"
    const values =
      raw === undefined
        ? [true]
        : raw === ""
          ? [null]
          : (f.many && !nested
              ? raw
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
              : [raw]
            ).map((t) => convert(f.type, t, name))
    const prev = out[name]
    const before: unknown[] = Array.isArray(prev) ? prev : []
    if (f.many) out[name] = values[0] === null ? null : [...before, ...values]
    else if (name in out) throw new DtError(`${name} is given twice, and it holds one value`)
    else out[name] = values[0]
  }
  return out
}
