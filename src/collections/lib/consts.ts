import { FIELD_OPTIONS, TEMPLATE_OPTIONS } from "../../compile/consts.ts"
import { INJECTED_FIELDS } from "../../record/consts.ts"

// A field is referenced BY NAME, not as a `<collection>/<id>` reference, so `store.rewriteRefs` can
// see none of it. Rule 6 is the list of every position a descriptor, a view or a binding may name a
// field in — compile validates each one — and these walkers visit exactly that list:
//
//   the collection's own sources (its base and every overlay):
//     `fields.<f>` · a field's `display.unit_field` · `storage.under.parent` · `ids.from` ·
//     `record_title` · `display.list.columns`/`sort`/`options` · `display.record.badge`/
//     `color_by`/`subtitle` · `display.form.sections` · every `constraints` property name
//   every other collection source:  a mirror's `mirror_of` naming the field on this collection
//   ui-views:          `filter` (one hop through a reference included) and the `display` block
//   command-bindings:  `available_when` · `done_when`
//   the records:       the frontmatter key
//
// Each walker REWRITES A COPY and records where it wrote, so a dry run, a refusal and the real run
// are one traversal and cannot disagree about what is affected. A position that cannot be rewritten
// — a source `npm install` would erase, a mixin every collection listing it shares, a filter hop
// through a union — is recorded too, and the verb refuses naming every one of them.

/** A layout option that names a field by the role it plays (§3.5.1). */
export const OPTION_FIELD_KEYS = FIELD_OPTIONS

/** A layout option that names several. */
export const OPTION_FIELD_LISTS = ["ref_fields", "value_fields"]

/** A layout option that is a template. */
export const OPTION_TEMPLATES = TEMPLATE_OPTIONS

/** The filter positions of a view or a binding. */
export const FILTER_KEYS: Record<string, string[]> = {
  "ui-views": ["filter"],
  "command-bindings": ["available_when", "done_when"],
}

/** Operators whose operand IS a value, rewritten exactly. */
export const VALUE_OPS = ["_eq", "_neq", "_ieq", "_nieq"]

export const LIST_OPS = ["_in", "_nin"]

/** The fields compile injects into every collection — no source declares one. */
export const INJECTED = new Set(Object.keys(INJECTED_FIELDS))

/**
 * Operators whose operand matches PART of a value: a rename can change what they select, and no
 * mechanical rewrite says how — so one that selects the old value is refused by name.
 */
export const PARTIAL_OPS: Record<string, (v: string, o: string) => boolean> = {
  _contains: (v, o) => v.includes(o),
  _ncontains: (v, o) => v.includes(o),
  _icontains: (v, o) => v.toLowerCase().includes(o.toLowerCase()),
  _starts_with: (v, o) => v.startsWith(o),
  _istarts_with: (v, o) => v.toLowerCase().startsWith(o.toLowerCase()),
  _ends_with: (v, o) => v.endsWith(o),
  _iends_with: (v, o) => v.toLowerCase().endsWith(o.toLowerCase()),
  _regex: (v, o) => {
    try {
      return new RegExp(o).test(v)
    } catch {
      return false
    }
  },
}
