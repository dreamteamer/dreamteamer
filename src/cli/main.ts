// The command line: reads it, finds the verb in the table, and prints. Each verb is a file in verbs/; every rule
// about records lives behind the functions those call.
import { resolve } from "node:path"
import { DtError } from "../lib/DtError.ts"
import { engineVersion } from "../lib/engineVersion.ts"
import { activate } from "../extensions/activate.ts"
import { messageOf } from "../lib/messageOf.ts"
import { buildModel } from "../model/buildModel.ts"
import { findCollection } from "../model/findCollection.ts"
import { parseArgs } from "./parseArgs.ts"
import type { Workspace } from "../types/Workspace.ts"
import type { Args } from "./Verb.ts"
import { isVerb, VERBS } from "./VERBS.ts"

const USAGE = [
  "usage: <verb> [target] [arguments] [-w <workspace>]",
  ...Object.values(VERBS).map((t) => `  ${t.usage}`),
  "  help | --version",
].join("\n")

async function run(argv: string[], out: (v: unknown) => void) {
  const args = [...argv]
  const w = args.findIndex((t) => t === "-w" || t === "--workspace" || t.startsWith("--workspace="))
  const given = w < 0 ? undefined : args[w].includes("=") ? args.splice(w, 1)[0].slice(12) : args.splice(w, 2)[1]
  if (w >= 0 && !given) throw new DtError("-w needs the path of a workspace")
  const root = resolve(given ?? process.cwd())
  if (args[0] === "--version") {
    out(`dreamteamer-first-principles ${engineVersion()}`)
    return 0
  }
  const verb = args.shift()
  if (!verb || verb === "help" || verb === "--help") {
    out(USAGE)
    return 0
  }
  if (verb.startsWith("-")) throw new DtError(`the verb comes first — got ${verb}\n${USAGE}`)
  if (!isVerb(verb)) {
    // a verb an installed extension adds runs in this process, handed the workspace and the arguments after it
    const ws = await Promise.resolve(root)
      .then((t) => activate(buildModel(t)))
      .catch(() => null)
    const ext = ws?.extensions.find((t) => Object.hasOwn(t.commands, verb))
    if (ws && ext) {
      const code = await ext.commands[verb](ws, args)
      return typeof code === "number" ? code : 0
    }
    out(`unknown verb ${verb}\n${USAGE}`)
    return 2
  }
  const v = VERBS[verb]
  const { pos, opts, fields } = parseArgs(verb, v, args)
  const [target, ...extra] = pos
  const model = buildModel(root)
  let ws: Promise<Workspace> | undefined
  const a: Args = {
    verb,
    model,
    pos,
    target,
    extra,
    opts,
    fields,
    out,
    ws: () => (ws ??= activate(model)),
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

/** Run one command line; the exit status is what it resolves to. A failure is one line, unless DT_DEBUG asks for the stack. */
export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv, (t) => console.log(typeof t === "string" ? t : JSON.stringify(t, null, 2)))
  } catch (e) {
    console.error(`✖ ${messageOf(e)}`)
    if (e instanceof DtError) e.issues.forEach((t) => console.error(`  ${t.where}: ${t.message}`))
    else if (process.env.DT_DEBUG) console.error(e instanceof Error ? e.stack : undefined)
    return 1
  }
}
