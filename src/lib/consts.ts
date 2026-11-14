import { type StdioOptions } from "node:child_process"

/** A path git will not let us rewrite usefully: `npm install` erases it. Matched on the SEGMENT, in
 *  either separator, because manifest paths carry the host's. */
export const IN_NODE_MODULES = (rel: unknown): boolean => /(^|[\\/])node_modules([\\/]|$)/.test(String(rel))

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

/** An IDENTITY entity kind — a compiled source file per id (skills, agents, commands, bindings,
 *  mixins, and any kind an extension contributes). Derived from the runtime rather than
 *  listed, so a contributed kind gets `set · rm · rename` without core knowing its name; `collections`,
 *  `ui-views` and `modules` have verbs of their own. */
export const OWN_VERBS = new Set(["collections", "ui-views", "modules"])

/**
 * THE ONE PLACE A FLAG NAME IS VALIDATED — every record, system and field verb goes through
 * `targetCommand`, so the check lives beside the parser they share rather than being
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

// ⚠ `module` and `dry-run` are VERB OPTIONS on every verb that takes them, so they may never be
// read as record field names. A collection wanting a field literally called `module` writes it as
// `module=<v>` positionally, which `pairs()` reads and `stripMeta` never sees.
export const META_FLAGS = new Set(["id", "json", "force", "filter", "module", "dry-run"])

// ---- writing a source a HUMAN wrote ---------------------------------------------
//
// `dump` is for GENERATED output — the compiled runtime, a record's front matter, a harness file —
// where nothing was hand-formatted and byte-stability is the only thing that matters. A module
// SOURCE is the opposite case: it is hand-written, and it is where a module records WHY a collection
// exists. `load` → mutate → `dump` destroys all of that, because a dump re-derives the whole file
// from the parsed value: every comment gone, every flow form (`templates: [a]`, `storage: { … }`)
// expanded to block, every hand-folded scalar re-wrapped at the writer's own width. One `add-field`
// on a commented descriptor took it to zero comments, and one namespacing migration lost 194 comment
// lines across 24 descriptors — headers stating what belongs in a collection and which failure mode
// it guards against. Nothing warned; the schema was unchanged, so every gate stayed green.
//
// Three hand-rolled textual workarounds were written against this before it was fixed properly (a
// `setScalar` regex, an `x-reference` line editor, and a `reattachComments` pass that could only
// carry TOP-LEVEL blocks). All three are retired by `writeSource`.
//
// ⚠ THE DOCUMENT API ALONE IS NOT ENOUGH, and that was measured rather than assumed. `yaml` keeps
// comments and key order across parse → mutate → stringify, but it re-derives STYLE from its options
// rather than from the source, so a plain round-trip still reformats: `[a, b]` gains or loses its
// padding depending on one global flag the file's own author used both ways, and a block-folded
// scalar is re-folded at `lineWidth` — hand-wrapping the library cannot see and cannot reproduce.
// Straight through the Document API, 27 of 92 hand-written sources round-tripped byte-identically.
//
// So the stringify is followed by a pass that puts the ORIGINAL BYTES back wherever nothing changed:
// walk the old and new documents together, and for every node — or every key/value pair — whose
// value is deep-equal on both sides, replace the newly-emitted span with the source it was parsed
// from. Unchanged means byte-identical BY CONSTRUCTION, so the diff can only ever be the mutation.
// With the pass, 92 of 92. `test/unit/yaml-source.test.js` is the reproduction.

// `lineWidth: 0` never re-folds — an unchanged scalar is restored verbatim below, and a changed one
// must not drag its neighbours onto new lines.
//
// ⚠ `flowCollectionPadding` is ONE flag for two conventions that genuinely differ. Counted over a
// real workspace's 92 hand-written sources: flow SEQUENCES are unpadded 183 times out of 183
// (`list_fields: [name, status]`), flow MAPPINGS are padded 118 times out of 120
// (`storage: { path: x }`). Only a CHANGED collection is re-emitted at all — everything else is
// restored byte-for-byte — and what these ops change is the sequences: `list_fields`, `required`,
// `enum` and `templates`. So the sequence convention wins, and a flow mapping loses its padding only
// on the line an `x-reference` retarget was already rewriting.
export const SOURCE_OPTS = { lineWidth: 0, flowCollectionPadding: false }

// git calls whose failure we CATCH must not print git's own error: execFileSync forwards the
// child's stderr to ours unless told otherwise, so a handled "not a git repository" still
// reached the user's terminal. stdout stays piped because we read it.
export const QUIET: StdioOptions = ["ignore", "pipe", "ignore"]

/**
 * A collection name in the singular — what one RECORD of it is called: `doctors` → `doctor`,
 * `stories` → `story`, `boxes` → `box`, `analyses` → `analysis`, `series` → `series`. Only the last
 * hyphenated word inflects (`meta-analyses` → `meta-analysis`). A name that is not a plural comes back
 * unchanged, which is what `inflects` reports, so compile can say so.
 *
 * Shared by three subsystems in different layers — compile derives an absent `singular` and
 * `storage.suffix` from it, `collections add` writes it into a new descriptor, `rename-collection`
 * asks whether a suffix was derived — so there is exactly one spelling of the rule.
 */
export const INVARIANT = new Set(["series", "species", "news"])

export const EXIT = { done: 0, failed: 1, usage: 2, needsInput: 3 }
