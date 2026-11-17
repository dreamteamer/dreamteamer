import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { asObject } from "../lib/asObject.ts"
import { isObject } from "../lib/isObject.ts"
import { titleOf } from "../lib/titleOf.ts"
import { moduleId } from "../model/moduleId.ts"
import { getSource } from "../store/getSource.ts"
import type { Collection } from "../types/Collection.ts"
import type { Model } from "../types/Model.ts"

/** prose on one line, from a value that may be a folded scalar or absent */
function flat(v: unknown) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : ""
}

/** a filter's operand as a template prints it */
function str(v: unknown, sep = ","): string {
  return Array.isArray(v) ? v.map((t) => str(t)).join(sep) : typeof v === "string" ? v : (JSON.stringify(v) ?? "")
}

/** what can refuse a write: a required field with no default (an input every id template names is one), a closed enum with its size, the first example */
function writeLine(c: Collection) {
  const fs = Object.entries(c.fields)
  const inputs = c.ids.from.map((t) => [...t.matchAll(/\{\{\s*([^\s|}]+)/g)].map((m) => m[1]))
  const ids = (inputs[0] ?? []).filter((t) => inputs.every((s) => s.includes(t)))
  const open = fs.filter(([n, f]) => (f.required || ids.includes(n)) && !(f.derived || f.virtual || "default" in f))
  const egs = fs.flatMap(([n, f]) => (Array.isArray(f.examples) ? [`${n}='${str(f.examples[0])}'`] : []))
  const enums = fs.flatMap(([n, f]) => (f.enum?.length ? [`${n} enum(${String(f.enum.length)})`] : []))
  const parts = [open.length ? `required ${open.map(([n]) => n).join(" · ")}` : "", enums.join(" · ")]
  return [...parts, egs.length ? `e.g. ${egs.join(", ")}` : ""].filter(Boolean).join("; ")
}

/** a binding's filter as written, literally: `status=draft`, `status in a|b`, `file set`, `meeting empty`, `(a or b)` */
function gate(v: unknown, at = ""): string[] {
  if (!isObject(v)) return []
  return Object.entries(v).flatMap(([k, x]) => {
    if (k === "_and" && Array.isArray(x)) return x.flatMap((t: unknown) => gate(t, at))
    if (k === "_or" && Array.isArray(x))
      return [`(${x.map((t: unknown) => gate(at ? { [at]: t } : t).join(", ")).join(" or ")})`]
    const o: Record<string, string> = {
      _eq: "=" + str(x),
      _in: " in " + str(x, "|"),
      _nempty: " set",
      _empty: " empty",
    }
    if (k.startsWith("_")) return [at + (Object.hasOwn(o, k) ? o[k] : ` ${k.slice(1)} ${str(x)}`)]
    return isObject(x) ? gate(x, at ? `${at}.${k}` : k) : [`${at ? `${at}.` : ""}${k}=${str(x)}`]
  })
}

/** each collection a binding names, with its commands and the record state that makes each available and done */
function bindings(model: Model) {
  const by = new Map<string, string[]>()
  for (const id of Object.keys(model.sources["command-bindings"] ?? {})) {
    const d = getSource(model, "command-bindings", id).data
    const [coll, cmd] = [d.collection, d.command].map((t) => flat(t).replace(/^(collections|commands)\//, ""))
    if (!coll || !cmd) continue
    const when = [["available when", d.available_when] as const, ["done when", d.done_when] as const]
    const g = when.flatMap(([l, f]) => (gate(f).length ? [`${l}: ${gate(f).join(", ")}`] : [])).join(" · ")
    by.set(coll, [...(by.get(coll) ?? []), `/${cmd.replaceAll("/", ":")}${g ? ` (${g})` : ""}`])
  }
  return [...by.keys()].sort().map((t) => `- ${t} — ${(by.get(t) ?? []).sort().join(" · ")}`)
}

/** what a module ships, as its released module record says it: its sentence, then its skills, commands and scripts */
function shipped(model: Model, dir: string) {
  const pkg = asObject(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), join(dir, "package.json"))
  const cfg = isObject(pkg.dreamteamer) ? pkg.dreamteamer : {}
  const under = (kind: string) =>
    Object.entries(model.sources[kind] ?? {})
      .flatMap(([id, p]) => (p.startsWith(dir + sep) ? [id] : []))
      .sort()
  const bin = existsSync(join(dir, "bin")) ? readdirSync(join(dir, "bin"), { withFileTypes: true }) : []
  const ships = {
    skills: under("skills"),
    commands: under("commands").map((t) => `/${t.replaceAll("/", ":")}`),
    runs: bin.flatMap((t) => (t.isFile() && !t.name.startsWith(".") ? [`bin/${t.name}`] : [])).sort(),
  }
  const lines = Object.entries(ships).flatMap(([k, t]) => (t.length ? [`${k}: ${t.join(" · ")}`] : []))
  return [flat([cfg.description, pkg.description].find((t) => flat(t))), ...lines]
}

/**
 * The released engine's orientation block, generated from the model: how the workspace is laid out, its namespaces,
 * the system collections, each module with what it ships and its collections' `use when` and `write` lines, the
 * mixins, and the commands bound to each collection — claude-code's flavour, which finds skills and commands itself.
 * Review: an extension's own paragraph, verbs and source kinds, and the workspace's own module, are not rendered.
 */
export function orientation(model: Model, version: string): string {
  const cs = Object.values(model.collections).sort((a, b) => a.name.localeCompare(b.name))
  const sys = cs.filter((t) => t.internal).sort((a, b) => +(b.name === "collections") - +(a.name === "collections"))
  const namespaces = [...new Set(model.modules.flatMap((t) => t.namespaces))].sort()
  const ns = namespaces.length
    ? `\nthis workspace declares NAMESPACES: ${namespaces.map((t) => `\`${t}\``).join(", ")}. a collection\nin one is named with its prefix (\`health/doctors\`), stores records under \`data/<namespace>/\`,\nand is referenced as \`<namespace>/<collection>/<id>\` — so split a reference at the end of the\nDECLARED prefix, not at the first slash. collections with no prefix are unaffected.`
    : ""
  const lines = [
    `this workspace is a typed record DSL operated by dreamteamer v${version} — collections are the\nnouns. **read the \`using-dreamteamer\` skill before working with data or changing what the\nworkspace keeps or does.** schemas (read): \`.dreamteamer/collections/\` (provenance:\n\`.dreamteamer/manifest.yaml\`). sources (write): \`modules/<module>/<kind>/\` — \`collections/\`, \`skills/\`, \`agents/\`, \`commands/\`,\n\`command-bindings/\`, \`ui-views/\`, \`mixins/\`\n(see manifest for channels). data: \`data/\`. records are \`<id>.<suffix>.<ext>\`\nfiles; ids are paths; references are \`<collection>/<id>\`. run \`dreamteamer check\` (\`npm run\ncheck\`) after bulk edits; run \`dreamteamer compile\` (\`npm run compile\`) after changing any\nsource or installing modules.\na reply that wrote records ends with the record report \`dt changes\` prints — the format is in the skill.${ns}`,
    "",
    `MODULES AND THEIR COLLECTIONS — what this workspace is for, one area at a time. A module ships\none domain: its collections (the nouns), and the skills and commands that operate on them —\nread its skills before working in its area. The descriptor at\n\`.dreamteamer/collections/<name>.collection.yaml\` is the authority on fields, id shape and\ndefaults — read it before writing a kind you have not written this session. Create records\nwith \`dt add <collection>\`: it generates the id and rejects invalid writes before disk. A\ncollection's \`write:\` line names only what the store REFUSES — required fields that have no\ndefault (a defaulted one is filled in for you), closed enums with their size, one example.`,
  ]
  const built = sys.filter((t) => model.sources[t.name]).map((t) => t.name)
  const kept = sys.filter((t) => !model.sources[t.name]).map((t) => t.name)
  lines.push(
    "",
    `**System collections** — the SAME verbs (add · set · rm · rename · list · get), plus \`dt add-field\`/\`set-field\`/\`rm-field\`/\`rename-field <collection>\`. A system write COMMITS ITSELF, in the repo holding the source; a record write does not (\`dt commit\` publishes).${built.length ? ` Never hand-edit \`.dreamteamer/\` — it is build output: ${built.join(" · ")}.` : ""}${kept.length ? ` Records you edit like any other: ${kept.join(" · ")}.` : ""}`,
  )
  function entry(c: Collection, write: boolean) {
    const w = write ? writeLine(c) : ""
    lines.push(`- ${c.name}${flat(c.description) ? ` — ${flat(c.description)}` : ""}`)
    if (flat(c.use_when)) lines.push(`    use when: ${flat(c.use_when)}`)
    if (w) lines.push(`    write: ${w}`)
  }
  for (const c of sys) entry(c, false)
  const groups = model.modules
    .map((m) => ({ m, id: moduleId(m.name), title: m.title ?? titleOf(moduleId(m.name)), s: shipped(model, m.dir) }))
    .filter(({ id, s }) => {
      const own = cs.filter((t) => moduleId(t.module) === id)
      return own.some((t) => !t.internal) || (!own.length && s.length > 1)
    })
    .sort((a, b) => a.title.localeCompare(b.title))
  for (const { m, id, title, s } of groups) {
    const ns = m.namespaces.length ? ` · namespaces: ${m.namespaces.join(" · ")}` : ""
    const where = `\`${id}\` · ${relative(model.root, m.dir).split(sep).join("/") || "the workspace root"}${ns}`
    lines.push("", `**${title}** (${where})${s[0] ? ` — ${s[0]}` : ""}`)
    if (s.length > 1) lines.push(`  ${s.slice(1).join(" · ")}`)
    for (const c of cs.filter((t) => !t.internal && moduleId(t.module) === id)) entry(c, true)
  }
  const mixins = Object.keys(model.sources.mixins ?? {}).map((id) => {
    const d = getSource(model, "mixins", id).data
    return `- ${flat(d.name) || id}${flat(d.description) ? ` — ${flat(d.description)}` : ""}`
  })
  if (mixins.length)
    lines.push("", "MIXINS — partial descriptors merged into the collections that list them:", ...mixins.sort())
  const bound = bindings(model)
  if (bound.length)
    lines.push("", "VERBS BOUND TO COLLECTIONS (`dt next <collection>[/<id>]` answers per record):", ...bound)
  return lines.join("\n")
}
