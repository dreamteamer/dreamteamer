// The command line: reads it, finds the verb in the table, and prints. Each verb is a file in verbs/; every rule
// about records lives behind the functions those call.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { asObject } from "../lib/asObject.ts"
import { asString } from "../lib/asString.ts"
import { DtError } from "../lib/DtError.ts"
import { messageOf } from "../lib/messageOf.ts"
import { buildModel } from "../model/buildModel.ts"
import { findCollection } from "../model/findCollection.ts"
import { parseArgs } from "./parseArgs.ts"
import type { Args } from "./Verb.ts"
import { isVerb, VERBS } from "./VERBS.ts"

const USAGE = [
  "usage: <verb> [target] [arguments] [-w <workspace>]",
  ...Object.values(VERBS).map((t) => `  ${t.usage}`),
  "  help | --version",
].join("\n")

function version() {
  const pkg = asObject(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")), "package.json")
  return asString(pkg.version, "package.json version")
}

function run(argv: string[], out: (v: unknown) => void) {
  const args = [...argv]
  const w = args.findIndex((t) => t === "-w" || t === "--workspace" || t.startsWith("--workspace="))
  const given = w < 0 ? undefined : args[w].includes("=") ? args.splice(w, 1)[0].slice(12) : args.splice(w, 2)[1]
  if (w >= 0 && !given) throw new DtError("-w needs the path of a workspace")
  const root = resolve(given ?? process.cwd())
  if (args[0] === "--version") {
    out(`dreamteamer-first-principles ${version()}`)
    return 0
  }
  const verb = args.shift()
  if (!verb || verb === "help" || verb === "--help") {
    out(USAGE)
    return 0
  }
  if (verb.startsWith("-")) throw new DtError(`the verb comes first — got ${verb}\n${USAGE}`)
  if (!isVerb(verb)) {
    out(`unknown verb ${verb}\n${USAGE}`)
    return 2
  }
  const v = VERBS[verb]
  const { pos, opts, fields } = parseArgs(verb, v, args)
  const [target, ...extra] = pos
  const model = buildModel(root)
  const a: Args = {
    verb,
    model,
    pos,
    target,
    extra,
    opts,
    fields,
    out,
    wanted(what) {
      if (!target) throw new DtError(`${verb} needs ${what}`)
      return target
    },
    noExtra(n = 0) {
      if (extra.length > n) throw new DtError(`${verb} does not take "${extra[n]}"`)
    },
    none() {
      if (pos.length) throw new DtError(`${verb} does not take "${pos[0]}"`)
    },
    collectionOf(name) {
      const c = findCollection(model, name)
      if (!c)
        throw new DtError(
          `unknown collection ${name} — the collections are ${Object.keys(model.collections).sort().join(", ")}`,
        )
      return c
    },
    done(r) {
      out(`✔ ${r.ref} · ${r.path}`)
      r.warnings?.forEach((t) => out(`⚠ ${t}`))
    },
  }
  return v.run(a)
}

/** Run one command line; the exit status is returned. A failure is one line, unless DT_DEBUG asks for the stack. */
export function main(argv: string[]): number {
  try {
    return run(argv, (t) => console.log(typeof t === "string" ? t : JSON.stringify(t, null, 2)))
  } catch (e) {
    console.error(`✖ ${messageOf(e)}`)
    if (e instanceof DtError) e.issues.forEach((t) => console.error(`  ${t.where}: ${t.message}`))
    else if (process.env.DT_DEBUG) console.error(e instanceof Error ? e.stack : undefined)
    return 1
  }
}
