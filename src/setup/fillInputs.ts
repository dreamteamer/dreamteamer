import os from "node:os"
import type { SetupInput, SetupInputs, SetupUnit } from "../types.ts"
import { secretPathProblem } from "./lib/secretPathProblem.ts"
import { expandHome, usage } from "./setup.ts"
import type { InputFlag, InputProblem, SetupIO } from "./types.ts"

const flagText = (f: InputFlag): string => `--input ${f.unit ? `${f.unit}.` : ""}${f.id}=`

/**
 * Fill every unit's inputs. Returns `inputs` (unit id → { inputId: value }), `missing` (required
 * inputs with no value from any source), `ignored` and `problems`. `prompt(input, default)` is called
 * only in a TTY, only for what is still missing, and only when `noInput` is false. Strict (the default)
 * throws a usage error for a flag naming no input, two values for one shared key, or a secret-path
 * that does not exist or is not owner-only — nothing has run yet. `lenient` (install, where npm has
 * already written) keeps going: the unknown flag is listed in `ignored`, the bad value in `problems`
 * with the input left unfilled, so the install still commits and the line says what is still needed.
 */
export async function fillInputs(
  units: SetupUnit[],
  {
    flags = [],
    env = {},
    tty = false,
    noInput = false,
    prompt = null,
    home = os.homedir(),
    lenient = false,
  }: {
    flags?: InputFlag[]
    env?: Record<string, string | undefined>
    tty?: boolean
    noInput?: boolean
    prompt?: SetupIO["prompt"] | null
    home?: string
    lenient?: boolean
  } = {}
): Promise<{
  inputs: Map<string, SetupInputs>
  missing: { unit: string; id: string }[]
  ignored: string[]
  problems: InputProblem[]
}> {
  const inputs = new Map<string, SetupInputs>(units.map(u => [u.id, {}]))
  const missing: { unit: string; id: string }[] = [],
    ignored: string[] = [],
    problems: InputProblem[] = []
  const refuse = (text: string, problem: InputProblem | null = null): void => {
    if (!lenient) throw usage(text)
    if (problem) problems.push(problem)
    else ignored.push(text)
  }
  // a bare --input id= is unambiguous when every unit declaring that id names the same env key
  const byId = new Map<string, { unit: string; env: string | null }[]>()
  for (const u of units)
    for (const i of u.inputs) (byId.get(i.id) ?? byId.set(i.id, []).get(i.id)).push({ unit: u.id, env: i.env ?? null })
  const valueOf = (u: SetupUnit, i: SetupInput, f: InputFlag): boolean =>
    f.unit
      ? f.unit === u.id && f.id === i.id
      : f.id === i.id && byId.get(i.id).every(d => d.env === (i.env ?? null) && (d.env !== null || d.unit === u.id))
  const live: InputFlag[] = []
  for (const f of flags) {
    const owners = byId.get(f.id) ?? []
    if (f.unit && !units.some(u => u.id === f.unit && u.inputs.some(i => i.id === f.id))) {
      refuse(`${flagText(f)} names no input of ${f.unit}`)
      continue
    }
    if (!f.unit && !owners.length) {
      refuse(`${flagText(f)} names no input of ${units.map(u => u.id).join(", ") || "any unit"}`)
      continue
    }
    if (!f.unit && owners.length > 1 && !owners.every(o => o.env !== null && o.env === owners[0].env)) {
      refuse(
        `${flagText(f)} is ambiguous: ${owners.map(o => `${o.unit}.${f.id}`).join(", ")} — say which with unit.id=`
      )
      continue
    }
    live.push(f)
  }
  // an env key shared by several inputs is one input: a flag for any of them fills all of them, and two
  // different values for it in one call are a refusal naming both (D39)
  const envValues = new Map<string, string>(),
    envFlag = new Map<string, InputFlag>(),
    conflicted = new Set<string>()
  for (const u of units)
    for (const i of u.inputs)
      for (const f of live) {
        if (!i.env || i.kind === "rows" || !valueOf(u, i, f)) continue // a rows input is repeatable: every flag is one more row
        if (envValues.has(i.env) && envValues.get(i.env) !== f.value && envFlag.get(i.env) !== f) {
          const first = envFlag.get(i.env)
          refuse(`${flagText(first)} and ${flagText(f)} name one key, ${i.env}, with different values — give one`, {
            unit: u.id,
            id: i.id,
            reason: `${flagText(first)} and ${flagText(f)} name one key, ${i.env}, with different values — give one`,
            required: false,
            env: i.env,
          })
          conflicted.add(i.env)
          continue
        }
        if (!envValues.has(i.env)) {
          envValues.set(i.env, f.value)
          envFlag.set(i.env, f)
        }
      }
  // a default declared by any input sharing the key is the key's default, and required is the OR of
  // every declaration sharing it (D39: one key, one input)
  const envDefaults = new Map<string, unknown>(),
    envRequired = new Set<string>()
  for (const u of units)
    for (const i of u.inputs)
      if (i.env) {
        if (i.default !== undefined && !envDefaults.has(i.env)) envDefaults.set(i.env, i.default)
        if (i.required) envRequired.add(i.env)
      }
  const isRequired = (i: SetupInput): boolean => !!i.required || (!!i.env && envRequired.has(i.env))
  for (const u of units) {
    for (const i of u.inputs) {
      if (i.env && conflicted.has(i.env)) continue
      let value: unknown
      const given = live.filter(f => valueOf(u, i, f)).map(f => f.value)
      if (i.kind === "rows") {
        if (given.length) value = given
      } else if (given.length) value = given.at(-1)
      else if (i.env && envValues.has(i.env)) value = envValues.get(i.env)
      else if (i.env && env[i.env] !== undefined && String(env[i.env]).trim() !== "") value = String(env[i.env])
      else if (i.default !== undefined) value = i.default
      else if (i.env && envDefaults.has(i.env)) value = envDefaults.get(i.env)
      if (value === undefined && tty && !noInput && prompt) {
        const answer = await prompt(i, i.default)
        if (answer !== undefined && answer !== null && String(answer).trim() !== "")
          value = i.kind === "rows" ? [String(answer)] : String(answer)
      }
      if (value === undefined) {
        if (isRequired(i)) missing.push({ unit: u.id, id: i.id })
        continue
      }
      if (i.kind === "path" || i.kind === "secret-path") value = expandHome(value as string, home)
      if (i.kind === "secret-path") {
        // a flag's bad value is the caller's to fix (usage, strict); one the environment or a default holds
        // is reported on the unit's line and left unfilled, whoever runs
        const problem = secretPathProblem(value as string)
        if (problem && given.length) {
          refuse(`--input ${i.id}=${problem}`, {
            unit: u.id,
            id: i.id,
            reason: problem,
            required: true,
            env: i.env ?? null,
          })
          continue
        }
        if (problem) {
          problems.push({ unit: u.id, id: i.id, reason: problem, required: isRequired(i), env: i.env ?? null })
          continue
        }
      }
      inputs.get(u.id)[i.id] = value
    }
  }
  return { inputs, missing, ignored, problems }
}
