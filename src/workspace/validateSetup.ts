import type { SetupInput, SetupInputKind, SetupUnit } from "../types.ts"
import { ENV_KEY, INPUT_KINDS, SETUP_VERSION } from "./consts.ts"

/** A unit or input as a module wrote it — untrusted until each key is checked below. */
type RawUnit = { [K in keyof SetupUnit]?: unknown }

type RawInput = { [K in Exclude<keyof SetupInput, "rows">]?: unknown } & { rows?: { columns?: unknown } }

const UNIT_ID = /^[a-z][a-z0-9-]*$/

const INPUT_ID = /^[a-z][a-z0-9_]*$/

const kindOf = (v: unknown): string =>
  Array.isArray(v) ? "a list" : v === null ? "null" : typeof v === "object" ? "an object" : typeof v

/**
 * Validate one package's `setup` contribution. Returns the units with their defaults filled and the
 * package name stamped as `module`, or the refusals — every one naming the unit and the field, so a
 * module author reads the message and fixes the one line.
 * `declared` is the package's `dreamteamer.env` and `dreamteamer.vars`: an input that names an env
 * key must also be declared there, so a variable is declared in exactly one place.
 */
export function validateSetup(
  name: string,
  value: unknown,
  { env = [], vars = [] }: { env?: string[]; vars?: string[] } = {}
): { units: SetupUnit[]; errors: string[] } {
  if (value === undefined || value === null) return { units: [], errors: [] }
  if (!Array.isArray(value))
    return { units: [], errors: [`extension ${name}: setup must be a list of units (got ${kindOf(value)})`] }
  const declared = new Set([...(env ?? []), ...(vars ?? [])])
  const errors: string[] = []
  const units: SetupUnit[] = []
  const seen = new Set<string>()
  for (const u of value as RawUnit[]) {
    if (!u || typeof u !== "object" || Array.isArray(u)) {
      errors.push(`extension ${name}: a setup unit must be an object (got ${kindOf(u)})`)
      continue
    }
    if (typeof u.id !== "string" || !UNIT_ID.test(u.id)) {
      errors.push(`extension ${name}: a setup unit id is a lowercase slug (got ${JSON.stringify(u.id)})`)
      continue
    }
    if (seen.has(u.id)) {
      errors.push(`extension ${name}: setup unit "${u.id}" is declared twice`)
      continue
    }
    seen.add(u.id)
    if (u.version !== SETUP_VERSION) {
      errors.push(
        `unit ${u.id} declares setup version ${u.version}; this engine understands ${SETUP_VERSION} — update the engine or the module`
      )
      continue
    }
    let bad = false
    for (const f of ["inspect", "plan"] as const)
      if (typeof u[f] !== "function") {
        errors.push(`unit ${u.id}: ${f} must be a function`)
        bad = true
      }
    // apply is optional since 0.48.0: a unit whose every action carries `env` needs none (the engine
    // performs those); a non-env action from an apply-less unit fails at run time, named (src/setup.js)
    if (u.apply !== undefined && typeof u.apply !== "function") {
      errors.push(`unit ${u.id}: apply must be a function when present`)
      bad = true
    }
    // `dt status` and `dt doctor` call inspect without awaiting, so an async one would read as "no
    // evidence — never ready" with no error anywhere; refused here by name instead (review finding 5)
    if (typeof u.inspect === "function" && u.inspect.constructor?.name === "AsyncFunction") {
      errors.push(`unit ${u.id}: inspect must be synchronous — dt status reads it without awaiting`)
      bad = true
    }
    const inputs: SetupInput[] = []
    const rawInputs = u.inputs ?? []
    if (!Array.isArray(rawInputs)) {
      errors.push(`unit ${u.id}: inputs must be a list`)
      bad = true
    } else {
      for (const i of rawInputs as RawInput[]) {
        if (!i || typeof i !== "object") {
          errors.push(`unit ${u.id}: an input must be an object (got ${kindOf(i)})`)
          bad = true
          continue
        }
        if (typeof i.id !== "string" || !INPUT_ID.test(i.id)) {
          errors.push(`unit ${u.id}: an input id is a lowercase identifier (got ${JSON.stringify(i.id)})`)
          bad = true
          continue
        }
        if (!(INPUT_KINDS as unknown[]).includes(i.kind)) {
          errors.push(
            `unit ${u.id}: input ${i.id} has kind ${JSON.stringify(i.kind)} — one of ${INPUT_KINDS.join(", ")}`
          )
          bad = true
          continue
        }
        if (i.env !== undefined) {
          if (typeof i.env !== "string" || !ENV_KEY.test(i.env)) {
            errors.push(
              `unit ${u.id}: input ${i.id} names env ${JSON.stringify(i.env)}, which is not an environment key`
            )
            bad = true
            continue
          }
          if (!declared.has(i.env)) {
            errors.push(
              `unit ${u.id}: input ${i.id} names env ${i.env}, which the package does not declare in dreamteamer.env or vars`
            )
            bad = true
            continue
          }
        }
        if (
          i.kind === "rows" &&
          !(
            Array.isArray(i.rows?.columns) &&
            i.rows.columns.length &&
            i.rows.columns.every((c: unknown) => typeof c === "string")
          )
        ) {
          errors.push(`unit ${u.id}: input ${i.id} is rows and must declare rows.columns`)
          bad = true
          continue
        }
        // id, kind, env and rows were checked above; title and prompt pass through as the module wrote them
        inputs.push({
          id: i.id,
          kind: i.kind as SetupInputKind,
          env: i.env as string | undefined,
          required: i.required === true,
          title: (i.title ?? i.id) as string,
          default: i.default,
          prompt: i.prompt as string | undefined,
          rows: i.rows as SetupInput["rows"],
        })
      }
    }
    if (bad) continue
    units.push({
      id: u.id,
      version: SETUP_VERSION,
      module: name,
      inputs,
      // checked above: inspect and plan are functions, apply is one when present
      inspect: u.inspect as SetupUnit["inspect"],
      plan: u.plan as SetupUnit["plan"],
      apply: u.apply as SetupUnit["apply"],
    })
  }
  return { units, errors }
}
