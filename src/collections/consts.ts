import { FIELD_OPTIONS, TEMPLATE_OPTIONS } from "../workspace/consts.ts"
import { INJECTED_FIELDS } from "../record/consts.ts"

// ---- modules ---------------------------------------------------------------------------------
// A module is THREE-SPELLED today: the package `name` (discovery, `dependencies`), the
// folder (the `workspace_module` key), and the slugged scope-stripped record id. The RECORD ID is
// the identity everywhere the operator types it — `--module <id>`, `modules/<id>` references,
// `dependencies` values — and the engine maps id → package name internally. `add modules` sets all
// three to one string so a new module never forks; an existing forked module keeps working, and
// `dt list modules` prints all three columns so the fork is visible.

/** A module id: the same id-safe alphabet a namespace segment uses, because it becomes a folder
 *  name, a package name and a record id at once. */
export const MODULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// ---- the positions that name a field, and a value ----------------------------------------------
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

/** A path git will not let us rewrite usefully: `npm install` erases it. Matched on the SEGMENT, in
 *  either separator, because manifest paths carry the host's. */
export const IN_NODE_MODULES = (rel: unknown): boolean => /(^|[\\/])node_modules([\\/]|$)/.test(String(rel))

/** The fields compile injects into every collection — no source declares one. */
export const INJECTED = new Set(Object.keys(INJECTED_FIELDS))

// ---- the identity entities: skills, agents, commands, command-bindings, mixins ----------------
// §3.1's last row. These are FLAT at a module root and stay flat (decision 274) — their ids are
// single segments, and namespacing them was cut with the wave that considered it.
//
// `add` is a SCAFFOLD for skills only, and refused with the path for the rest. That asymmetry is not
// arbitrary: a skill's minimum-that-compiles is two frontmatter keys and an empty body, which a verb
// can write honestly. An agent, a command, a binding and a mixin are all PROSE or PREDICATES —
// the value is entirely in what a human writes, and a verb that scaffolds one produces a file whose
// only content is the fact that a verb made it.

/** kind → {suffix, folder} — one table, because five verbs read it and a sixth spelling of "where
 *  does a command live" is how a kind the engine stopped knowing sat in a module for two days
 *  (decision 156). */
export const ENTITY_SHAPE: Record<string, { suffix: string; folder: boolean }> = {
  skills: { suffix: "SKILL.md", folder: true },
  agents: { suffix: ".agent.md", folder: false },
  commands: { suffix: ".command.md", folder: false },
  "command-bindings": { suffix: ".command-binding.yaml", folder: false },
  mixins: { suffix: ".mixin.yaml", folder: false },
}

export const ENTITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const UNKNOWN_TOKEN = Symbol("unknown token")

/** An IDENTITY entity kind — a compiled source file per id (skills, agents, commands, bindings,
 *  mixins, and any kind an extension contributes). Derived from the runtime rather than
 *  listed, so a contributed kind gets `set · rm · rename` without core knowing its name; `collections`,
 *  `ui-views` and `modules` have verbs of their own. */
export const OWN_VERBS = new Set(["collections", "ui-views", "modules"])

/**
 * THE ONE PLACE A FLAG NAME IS VALIDATED — every record, system and field verb goes through
 * `collectionCommand`, so the check lives beside the parser they share rather than being
 * re-invented per verb.
 *
 * ⚠ IT EXISTS BECAUSE THE PARSER USED TO SWALLOW EVERYTHING. `dt add modules --name hr --bogusflag x`
 * succeeded silently, so a misspelled flag and a supported one were indistinguishable — and that is
 * what let `add modules --namespace hr` be accepted-and-ignored for a whole release with nobody
 * noticing. The worst instance was `--dryrun`, where the swallowed flag is the one standing between
 * a plan and a self-committed delete.
 *
 * TWO VOCABULARIES, and the split is what keeps the refusal honest. A verb's OPTIONS are closed and
 * enumerated here; an entity's own KEYS are open and cannot be — `dt list people --status todo` is a
 * shorthand filter on a declared field, `dt add people --name Ada` writes one, and a ui-view's
 * `display.list.options.*` is an open bag by design. So the allowlist is the table PLUS the target's declared
 * properties, and nothing is refused that either half can name.
 *
 * ⚠ A REFUSAL THAT REJECTS A VALID FLAG IS WORSE THAN THE SILENCE IT REPLACES, which is why a verb
 * with no table entry is left exactly as it was rather than being guessed at — and why the field
 * verbs' row is the whole `fieldFromFlags` vocabulary, read off nothing, so a flag added there has to be
 * added here too or its own test fails.
 *
 * A key is `<collection>:<verb>` where the system entity has its own interceptor, `<verb>` otherwise.
 */
export const FIELD_FLAGS = [
  "json",
  "module",
  "name",
  "type",
  "enum",
  "default-value",
  "default",
  "required",
  "description",
  "many",
  "unique",
  "soft",
  "body",
  "sensitive",
  "on-delete",
  "mirror-of",
]

const JSON_ONLY = ["json"]

const FORCE_RM = ["json", "force", "dry-run"]

const NAV_MOVE = ["json", "after", "before", "top", "bottom"]

export const VERB_FLAGS: Record<string, string[]> = {
  list: ["json", "filter", "where", "sort"],
  get: ["json", "referrer"],
  add: ["json", "id", "from", "force"],
  set: JSON_ONLY,
  rm: FORCE_RM,
  rename: JSON_ONLY,
  reorder: [...NAV_MOVE, "init"],
  values: ["json", "limit"],
  history: JSON_ONLY,
  diff: ["json", "hash"],
  revert: ["json", "hash"],
  ensure: ["json", "all"],
  for: ["json", "ids"],
  relations: JSON_ONLY,
  rebuild: ["json", "drop"],
  "add-field": FIELD_FLAGS,
  "set-field": FIELD_FLAGS,
  "rm-field": ["json", "module", "name", "dry-run"],
  "rename-field": ["json", "name", "to", "dry-run"],
  "rename-value": ["json", "dry-run"],
  "collections:add": ["json", "module", "name", "namespace", "mixins", "id-from", "description", "suffix"],
  "collections:get": ["json", "module"],
  "collections:set": ["json", "module", "dry-run"],
  "collections:rm": FORCE_RM,
  "collections:rename": ["json", "namespace", "dry-run"],
  "collections:reorder": NAV_MOVE,
  "modules:add": ["json", "name", "description", "namespace", "extension", "package"],
  "modules:rename": JSON_ONLY,
  "modules:rm": FORCE_RM,
  "modules:set": ["json", "description", "namespaces", "dependencies", "peer_collections"],
  // the identity kinds: `add` scaffolds, `rm`/`rename` fall through to the generic rows, and `set`
  // is deliberately UNCHECKED — a skill's frontmatter is an open document (`allowed-tools`, `model`,
  // whatever a harness reads), so there is no closed set to check it against.
  "skills:add": ["json", "module", "name", "description"],
  "ui-views:add": ["json", "module", "id", "force"],
  "ui-views:set": ["json", "module", "id", "force", "dry-run"],
  "ui-views:rm": FORCE_RM,
}

/** Operators whose operand matches PART of a value: a rename can change what they select, and no
 *  mechanical rewrite says how — so one that selects the old value is refused by name. */
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
