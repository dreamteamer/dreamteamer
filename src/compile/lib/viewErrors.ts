import { VALUE_TOKENS } from "../../record/consts.ts"
import { unknownOperators } from "../../record/unknownOperators.ts"
import { unknownTokens } from "../../record/unknownTokens.ts"
import { validateTemplate } from "../../record/validateTemplate.ts"
import type { Field } from "../../types.ts"
import { filterFields } from "./filterFields.ts"
import type { ViewCheck } from "./types.ts"
import { has, isMap } from "../views.ts"
import { BUILTIN_FIELDS, FIELD_OPTIONS, TEMPLATE_OPTIONS } from "../consts.ts"
import { VIEW_DISPLAY } from "./consts.ts"

/** The keys a ui-view carries, in canonical order. `compiled` is compile's, never authored. */
const VIEW_KEYS = ["name", "title", "description", "route", "scope", "collection", "filter", "display"]

const VIEW_SCOPES = ["record", "collection", "page"]

const GROUP_TEMPLATES = ["group_title", "group_summary"]

// what marks a source as written in the format before this one: only ever used to send it to the
// converter, which compile names once for every such file (`v1: true` on the result)
const V1_VIEW_KEYS = ["path", "target", "layout", "options", "nav"]

/** The fields a `group_by` field's groups expose to a group template, or null when it groups by nothing known. */
type GroupFields = ((groupBy: unknown) => Record<string, unknown> | null | undefined) | undefined

/**
 * Validate one ui-view.
 * @param {object} view
 * @param {{ file: string, fields?: object, lenient?: boolean }} ctx
 *   fields  — the named collection's resolved fields, or undefined when it is not known here (an
 *             unknown collection is `check`'s to report, through the reference)
 *   lenient — the view's module declares a peer collection that is not installed
 * @returns {{ errors: string[], warnings: string[], v1?: true }} each naming its position
 */
export function viewErrors(
  view: unknown,
  {
    file,
    fields,
    groupFields,
    lenient = false,
  }: { file: string; fields?: Record<string, Field> | null; groupFields?: GroupFields; lenient?: boolean }
): ViewCheck {
  if (!isMap(view)) return { errors: [`${file}: a ui-view is a mapping`], warnings: [] }
  if (V1_VIEW_KEYS.some(k => k in view) && !("route" in view || "scope" in view || "display" in view))
    return { v1: true, errors: [], warnings: [] }
  const errors: string[] = []
  const names: string[] = []
  const at = (msg: string): number => errors.push(`${file}: ${msg}`)
  for (const k of Object.keys(view)) {
    if (VIEW_KEYS.includes(k)) continue
    if (k === "default")
      at(
        "`default` — a view is always a named variant; the collection's own `display` is its default view. Move this view's display into the collection's descriptor, or drop the key."
      )
    else at(`unknown key \`${k}\` — a ui-view's keys are ${VIEW_KEYS.join(" · ")}`)
  }
  if (typeof view.route !== "string" || !view.route.startsWith("/"))
    at("`route` is required: the path this view renders at, starting with /")
  if (!VIEW_SCOPES.includes(view.scope as string)) at(`\`scope\` is required: ${VIEW_SCOPES.join(" · ")}`)
  if (view.scope !== "page" && typeof view.collection !== "string")
    at("`collection` is required for a record or collection view: collections/<name>")
  if (view.filter !== undefined) {
    if (!isMap(view.filter)) at("`filter` is a mapping of field → condition")
    else {
      const bad = [...unknownOperators(view.filter)]
      if (bad.length) at(`filter: unknown filter operator(s) ${bad.join(", ")}`)
      const tokens = [...unknownTokens(view.filter)]
      if (tokens.length)
        at(`filter holds unknown value token(s) ${tokens.join(", ")} — the tokens are ${VALUE_TOKENS.join(" and ")}`)
      if (fields)
        for (const f of filterFields(view.filter))
          if (!has(fields, f)) names.push(`${file}: filter names "${f}", which is not a field of ${view.collection}`)
    }
  }
  const warnings: string[] = []
  if (view.display !== undefined)
    displayErrors(view.display, { fields, groupFields, collection: view.collection, errors, names, warnings, file })
  return lenient ? { errors, warnings: [...warnings, ...names] } : { errors: [...errors, ...names], warnings }
}

function displayErrors(
  display: unknown,
  {
    fields,
    groupFields,
    collection,
    errors,
    names: dangling,
    warnings,
    file,
  }: {
    fields?: Record<string, Field> | null
    groupFields?: GroupFields
    collection: unknown
    errors: string[]
    names: string[]
    warnings: string[]
    file: string
  }
): number | void {
  const err = (m: string): number => errors.push(`${file}: ${m}`)
  if (!isMap(display)) return err("`display` is a mapping of nav · list · record · form")
  const names = fields ? [...Object.keys(fields), ...BUILTIN_FIELDS] : null
  const field = (pos: string, f: unknown): void => {
    if (names && !names.includes(String(f).replace(/^-/, "")))
      dangling.push(`${file}: ${pos} names "${f}", which is not a field of ${collection}`)
  }
  const template = (tpl: unknown, position: string, over: string[] | null = names): void => {
    for (const e of validateTemplate(tpl as string, { position, fields: over }))
      (/is not a field/.test(e) ? dangling : errors).push(`${file}: ${e}`)
  }
  for (const [b, v] of Object.entries(display)) {
    if (!VIEW_DISPLAY[b]) {
      err(`unknown key \`display.${b}\` — display has ${Object.keys(VIEW_DISPLAY).join(" · ")}`)
      continue
    }
    if (!isMap(v)) {
      err(`\`display.${b}\` is a mapping`)
      continue
    }
    for (const k of Object.keys(v))
      if (!VIEW_DISPLAY[b].includes(k))
        err(`unknown key \`display.${b}.${k}\` — ${b} has ${VIEW_DISPLAY[b].join(" · ")}`)
    if (v.columns !== undefined) {
      if (!Array.isArray(v.columns)) err(`display.${b}.columns is a list of field names`)
      else for (const c of v.columns) field(`display.${b}.columns`, c)
    }
    if (v.sort !== undefined && v.sort !== "") field(`display.${b}.sort`, v.sort)
    for (const k of ["badge", "color_by"]) if (v[k] !== undefined) field(`display.${b}.${k}`, v[k])
    if (v.subtitle !== undefined && names) template(v.subtitle, `display.${b}.subtitle`)
    for (const [i, s] of (Array.isArray(v.sections) ? v.sections : []).entries())
      for (const f of (s as { fields?: unknown[] } | null)?.fields ?? []) field(`display.${b}.sections[${i}]`, f)
    if (v.options !== undefined) {
      if (!isMap(v.options)) {
        err(`display.${b}.options is a mapping`)
        continue
      }
      // options is open — each layout reads its own keys, and a surface may want one that collides —
      // but a key of the block or of the view itself, written down here, is read by nobody
      for (const k of Object.keys(v.options)) {
        if (VIEW_DISPLAY[b].includes(k))
          warnings.push(
            `${file}: display.${b}.options.${k} is read by nothing — \`${k}\` is a key of display.${b}, one level up`
          )
        else if (VIEW_KEYS.includes(k))
          warnings.push(
            `${file}: display.${b}.options.${k} is read by nothing — \`${k}\` is a key of the view itself, at the top`
          )
      }
      for (const k of FIELD_OPTIONS) if (v.options[k] !== undefined) field(`display.${b}.options.${k}`, v.options[k])
      for (const k of TEMPLATE_OPTIONS) {
        if (v.options[k] === undefined || !names) continue
        // a group's title and summary render over the record the rows are grouped BY — the target of
        // a reference group_by — so they are checked against that collection, or not at all
        if (GROUP_TEMPLATES.includes(k)) {
          const over = groupFields?.(v.options.group_by)
          if (over) template(v.options[k], `display.${b}.options.${k}`, [...Object.keys(over), ...BUILTIN_FIELDS])
        } else template(v.options[k], `display.${b}.options.${k}`)
      }
    }
  }
}
