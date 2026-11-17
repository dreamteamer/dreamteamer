import { mapOf } from "../lib/mapOf.ts"
import { titleOf as fieldTitle } from "../lib/titleOf.ts"
import { textOf } from "../lib/compareValues.ts"
import { accessors as a, type Released } from "./accessors.ts"

/** the wire type of a field: its type name, except a reference, which travels as a string */
const WIRE_TYPES = new Set([
  "string",
  "markdown",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "url",
  "email",
  "object",
  "map",
  "position",
])
/** the keys an enum entry may carry onto a choice row, copied by name */
const CHOICE_KEYS = ["description", "icon", "color", "background"]
/** where the three fields every record has are not drawn */
const INJECTED_HIDDEN: Record<string, (f: Record<string, unknown>) => string[] | undefined> = {
  id: (f) => (f.virtual ? ["list", "form", "record"] : undefined),
  created: (f) => (f.derived ? ["form"] : undefined),
  last_modified: (f) => (f.virtual ? ["form"] : undefined),
}

type Row = Record<string, unknown>

/** the parts as one row, later keys over earlier */
function merge(...parts: Row[]): Row {
  const out: Row = {}
  for (const t of parts) Object.assign(out, t)
  return out
}

/** the keys of `src` that are defined, in `keys` order */
function pick(src: Row, keys: string[]): Row {
  const out: Row = {}
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k]
  return out
}

/** the resolved display, its four sub-blocks always present */
function displayOf(d: Released) {
  const res: Record<string, Row> = Object.assign({ nav: {}, list: {}, record: {}, form: {} }, a.displayOf(d))
  return res
}

/** the authored form sections: each a title, its fields and whether it is drawn shut */
function sectionsOf(form: Row) {
  return (Array.isArray(form.sections) ? form.sections : []).map(mapOf).map((t) => {
    const s: { title: unknown; fields: unknown[]; collapsed: boolean } = {
      title: t.title,
      fields: Array.isArray(t.fields) ? t.fields : [],
      collapsed: t.collapsed === true,
    }
    return s
  })
}

function formSectionOf(f: Row) {
  return mapOf(f.display).form_section
}

function collectionRow(d: Released, declared: Record<string, Row>): Row {
  const { nav, list, record, form } = displayOf(d)
  const drawn = (n: unknown) => typeof n === "string" && declared[n] !== undefined && !declared[n].deprecated
  const sections = sectionsOf(form)
  const titles = [...sections.map((t) => t.title), ...Object.values(declared).map(formSectionOf)].filter(
    (t, i, all) => t !== undefined && all.indexOf(t) === i,
  )
  const columns = Array.isArray(list.columns) ? list.columns.filter(drawn) : undefined
  return merge(
    {
      collection: d?.name,
      title: a.titleOf(d),
      nav: pick(nav, ["icon", "order", "section"]),
      list: Object.assign(
        { layout: list.layout ?? "table" },
        pick(Object.assign({}, list, { columns }), ["columns", "sort", "options"]),
      ),
      record: Object.assign(
        { layout: record.layout ?? "page" },
        pick(record, ["subtitle", "badge", "color_by", "options"]),
      ),
      form: {
        sections: titles.map((title) => {
          const s = sections.find((t) => t.title === title)
          const authored = s?.fields ?? []
          const named = Object.keys(declared).filter(
            (n) => formSectionOf(declared[n]) === title && !authored.includes(n),
          )
          return Object.assign(
            { title, fields: [...authored, ...named].filter(drawn) },
            s?.collapsed ? { collapsed: true } : {},
          )
        }),
      },
    },
    pick({ position_field: a.positionFieldOf(d), record_title: a.recordTitleOf(d) }, [
      "position_field",
      "record_title",
    ]),
    { record_type: a.storageOf(d).suffix ?? d?.name, runtime: a.isRuntime(d), internal: a.isInternal(d) },
  )
}

/** a choice row: the value, its label, and the decoration its enum entry carries */
function choiceRow(value: unknown, entry: Row): Row {
  const row: Row = { label: textOf(entry.label ?? value), value }
  for (const k of CHOICE_KEYS) if (typeof entry[k] === "string" && entry[k]) row[k] = entry[k]
  return row
}

/** what a field's component needs beyond the field: its choices, an object's sub-fields, `display.options` */
function componentOptions(f: Row) {
  const values = f.enum === undefined ? null : a.enumValues(f.enum)
  // this engine keeps an enum map's entries as `choices`; a released descriptor keeps them on `enum`
  const decoration = mapOf(f.choices ?? (Array.isArray(f.enum) ? undefined : f.enum))
  const out = Object.assign(
    pick(
      {
        choices: values?.map((v) => choiceRow(v, mapOf(decoration[String(v)]))),
        fields:
          f.type === "object" ? Object.entries(mapOf(f.fields)).map(([n, t]) => fieldRow(n, mapOf(t))) : undefined,
        item_title: f.item_title,
      },
      ["choices", "fields", "item_title"],
    ),
    mapOf(mapOf(f.display).options),
  )
  return Object.keys(out).length ? out : undefined
}

/** one field as surfaces draw it */
function fieldRow(name: string, f: Row, required = f.required === true, body = f.body === true): Row {
  const display = mapOf(f.display)
  const kind = a.mirrorOf(f) !== undefined ? "mirror" : f.derived ? "derived" : f.virtual ? "virtual" : undefined
  const reference = a.targetsOf(f) !== null
  const role = body
    ? "body"
    : kind === "mirror"
      ? "mirror"
      : !reference
        ? undefined
        : f.many
          ? "reference_many"
          : "reference"
  const hidden = f.deprecated ? ["list", "form", "record"] : (INJECTED_HIDDEN[name]?.(f) ?? display.hidden)
  const options = componentOptions(f)
  return merge(
    {
      field: name,
      type: typeof f.type === "string" && WIRE_TYPES.has(f.type) ? f.type : "string",
      title: f.title ?? fieldTitle(name),
    },
    pick({ description: f.description || undefined }, ["description"]),
    { required },
    pick({ many: f.many || undefined, kind }, ["many", "kind"]),
    { editable: kind ? false : (display.editable ?? true) },
    pick({ hidden: Array.isArray(hidden) && hidden.length ? hidden.map((t: unknown) => t) : undefined, role }, [
      "hidden",
      "role",
    ]),
    pick(Object.assign({}, display, { editor_options: options, viewer_options: options }), [
      "editor",
      "editor_options",
      "viewer",
      "viewer_options",
    ]),
    pick({ mirror_of: a.mirrorOf(f), on_delete: f.on_delete }, ["mirror_of", "on_delete"]),
    pick({ unique: f.unique || undefined }, ["unique"]),
    { nullable: !required },
    pick(f, ["default"]),
    pick(display, ["unit", "unit_field", "direction", "width", "placeholder"]),
    pick({ deprecated: f.deprecated || undefined, sensitive: f.sensitive || undefined }, ["deprecated", "sensitive"]),
  )
}

/** the collections a reference names; none for a scalar and for `reference`, which names any */
function collectionTargets(f: Row) {
  const t = a.targetsOf(f)
  return Array.isArray(t) ? t : []
}

/**
 * The display contract, as the released engine's `presentation()` computes it from compiled descriptors: a row per
 * collection (title, nav, list, record, form), the fields each draws, and every relation between them.
 */
export function presentation(descriptors: Map<string, Released>) {
  const all = [...descriptors.values()]
  const mirrored = new Set<string>()
  for (const d of all)
    for (const f of Object.values(a.fieldsOf(d))) {
      const m = a.mirrorOf(f)
      if (m !== undefined) for (const t of collectionTargets(f)) mirrored.add(`${t}\0${m}`)
    }
  const collections: Row[] = []
  const fields: Record<string, Row[]> = {}
  const relations: Row[] = []
  const order = (d: Released) => {
    const o = displayOf(d).nav.order
    return typeof o === "number" ? o : Infinity
  }
  for (const d of all.sort((x, y) => order(x) - order(y))) {
    const name = String(d?.name)
    const declared = a.fieldsOf(d)
    const required = new Set(a.requiredOf(d))
    const body = a.bodyFieldOf(d)
    collections.push(collectionRow(d, declared))
    const sectionOf = new Map(
      sectionsOf(displayOf(d).form)
        .flatMap((s) => s.fields.map((n) => [n, s.title] as const))
        .reverse(),
    )
    fields[name] = Object.entries(declared).map(([n, f]) => {
      const row = Object.assign({ collection: name }, fieldRow(n, f, required.has(n), n === body))
      const section = formSectionOf(f) ?? sectionOf.get(n)
      if (section !== undefined && !f.deprecated) row.form_section = section
      return row
    })
    for (const [n, f] of Object.entries(declared)) {
      const mirror = a.mirrorOf(f) !== undefined
      const kind = mirror || !mirrored.has(`${name}\0${n}`) ? undefined : f.many ? "m2m" : f.unique ? "o2o" : "m2o"
      for (const target of collectionTargets(f))
        relations.push(
          Object.assign(
            { collection: name, field: n, related_collection: target, list: f.many === true },
            pick({ kind, mirror: mirror || undefined }, ["kind", "mirror"]),
          ),
        )
    }
  }
  const res = { collections, fields, relations }
  return res
}
