// The command line: reads it and prints. A value is converted by the declared type of its field; every rule about
// records lives behind the functions this calls.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { compile } from "../compile/compile.ts"
import { asObject } from "../lib/asObject.ts"
import { asString } from "../lib/asString.ts"
import { DtError } from "../lib/DtError.ts"
import { messageOf } from "../lib/messageOf.ts"
import { buildModel } from "../model/buildModel.ts"
import { findCollection } from "../model/findCollection.ts"
import { splitRef } from "../model/splitRef.ts"
import { add } from "../store/add.ts"
import { check } from "../store/check.ts"
import { get } from "../store/get.ts"
import { list } from "../store/list.ts"
import { rm } from "../store/rm.ts"
import { set } from "../store/set.ts"
import type { DtRecord } from "../types/DtRecord.ts"
import type { Severity } from "../types/Issue.ts"
import { fieldValues } from "./fieldValues.ts"
import { parseArgs } from "./parseArgs.ts"
import { isVerb } from "./VERBS.ts"

const USAGE = `usage: <verb> [target] [arguments] [-w <workspace>]
  modules                                  the modules this workspace has
  collections                              the collections they define
  list <collection> [--filter <field>=<value>]… [--json]
  get <ref> [--json]
  add <collection> ["<title>"] --<field> <value>… [--id <id>]
  set <ref> <field>=<value>…               an empty value clears a field
  rm <ref> [--force]
  check                                    validate every record; changes nothing
  compile                                  write .dt/AGENTS.md and .dt/model.json
  help | --version`

const MARKS = { error: "✖", warning: "⚠" } as const satisfies Record<Severity, string>

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
  const { pos, opts, fields } = parseArgs(verb, args)
  const [target, ...extra] = pos
  const model = buildModel(root)
  function wanted(what: string) {
    if (!target) throw new DtError(`${verb} needs ${what}`)
    return target
  }
  function noExtra(n = 0) {
    if (extra.length > n) throw new DtError(`${verb} does not take "${extra[n]}"`)
  }
  function none() {
    if (pos.length) throw new DtError(`${verb} does not take "${pos[0]}"`)
  }
  function collectionOf(name: string) {
    const c = findCollection(model, name)
    if (!c)
      throw new DtError(
        `unknown collection ${name} — the collections are ${Object.keys(model.collections).sort().join(", ")}`,
      )
    return c
  }
  function done(r: DtRecord) {
    out(`✔ ${r.ref} · ${r.path}`)
    r.warnings?.forEach((t) => out(`⚠ ${t}`))
  }
  switch (verb) {
    case "modules":
      none()
      model.modules.forEach((t) =>
        out(
          `${t.name}@${t.version} [${t.origin}]${t.unsupported.length ? ` — not acted on here: ${t.unsupported.join(", ")}` : ""}`,
        ),
      )
      return 0
    case "collections":
      none()
      Object.values(model.collections).forEach((t) =>
        out(`${t.name} (${t.module}) — ${Object.keys(t.fields).length} fields`),
      )
      return 0
    case "list": {
      noExtra()
      const where = Object.fromEntries(
        (opts.filter ?? []).map((f) => {
          if (!f.includes("=")) throw new DtError(`--filter takes <field>=<value>, got "${f}"`)
          return [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)]
        }),
      )
      const records = list(model, wanted("a collection"), where)
      if (opts.json) out(records)
      else records.forEach((t) => out(t.id))
      return 0
    }
    case "get":
      noExtra()
      out(
        opts.json
          ? get(model, wanted("a <collection>/<id> reference"))
          : get(model, wanted("a <collection>/<id> reference")).data,
      )
      return 0
    case "add": {
      const c = collectionOf(wanted("a collection"))
      noExtra(1)
      // one bare argument is the record's title: its `name`, else its `title`, else its first required text field
      const required = Object.keys(c.fields).filter((t) => c.fields[t].required && c.fields[t].type === "string")
      const title = ["name", "title", ...required].find((t) => c.fields[t])
      if (extra.length && !title)
        throw new DtError(`${c.name} has no title field to put "${extra[0]}" in — name the field`)
      const named: [string, string | undefined][] = title !== undefined && extra.length ? [[title, extra[0]]] : []
      done(add(model, c.name, fieldValues(c, [...named, ...fields]), opts.id?.[0]))
      return 0
    }
    case "set": {
      noExtra()
      const at = splitRef(model, wanted("a <collection>/<id> reference"), true)
      if (!at) throw new DtError(`${target}: not a <collection>/<id> reference`)
      if (!fields.length) throw new DtError("nothing to set — give <field>=<value> pairs")
      done(set(model, target, fieldValues(model.collections[at.collection], fields)))
      return 0
    }
    case "rm":
      noExtra()
      out(`✔ removed ${rm(model, wanted("a <collection>/<id> reference"), Boolean(opts.force))}`)
      return 0
    case "compile":
      none()
      compile(model).forEach((t) => out(`✔ ${t}`))
      return 0
    default: {
      none()
      const { records, issues } = check(model)
      issues.forEach((t) => out(`${MARKS[t.severity]} ${t.where}: ${t.message}`))
      const errors = issues.filter((t) => t.severity === "error").length
      const counts = `${Object.keys(model.collections).length} collections · ${model.modules.length} modules`
      out(`${records} records · ${counts} · ${errors} errors · ${issues.length - errors} warnings`)
      return errors ? 1 : 0
    }
  }
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
