import { type StdioOptions } from "node:child_process"

/** The authored types, in the order the help text lists them. A collection may not be named after one. */
export const SCALAR_TYPES = [
  "string",
  "markdown",
  "boolean",
  "integer",
  "number",
  "date",
  "datetime",
  "url",
  "email",
  "reference",
  "object",
  "map",
  "position",
]

export const EXPORTS_FILE = "dreamteamer-exports.json"

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

// ---- the grammar, for compile and for display ----------------------------------------------------

export const FILTERS = ["date", "datetime", "slug", "pad", "basename"]

// ---- shared reader primitives (review finding 11: walk/EXT existed 2-4×, diverging) ----

export const EXT: Record<string, string> = { md: ".md", yaml: ".yaml", json: ".json" }

/** How big a `format: binary` record may be before `check` says something, when its collection does not
 *  say otherwise. 200 KB fits an icon, a logo, a small illustration or a compressed photo, and does
 *  not fit the video someone will one day try to make a record. */
export const MAX_RECORD_BYTES = 204800

export const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3})\d*)?\s*(Z|[+-]\d{2}:?\d{2})?$/i

// git calls whose failure we CATCH must not print git's own error: execFileSync forwards the
// child's stderr to ours unless told otherwise, so a handled "not a git repository" still
// reached the user's terminal. stdout stays piped because we read it.
export const QUIET: StdioOptions = ["ignore", "pipe", "ignore"]

/** How many rows a report prints before it summarises the rest. */
export const ROWS_SHOWN = 20

/** The VS Code-family extensions for this workspace, as the editor learns of them: recommendations
 *  in `.vscode/extensions.json`, which VS Code, Cursor and code-server all read on open and offer to
 *  install. The studio extension, and beside it Claude Code, the agent a workspace's harness files are
 *  compiled for. Written by `init` and kept current by `compile`, because a compiled workspace that
 *  never names its editor left a first-run agent searching a registry for the id (measured 2026-09-24:
 *  three install attempts, two of them into a directory the running editor did not read). An
 *  existing file is MERGED, never replaced: an id the file already names anywhere — recommended, or
 *  listed under `unwantedRecommendations` by an operator who declined it — counts as present, in any
 *  case (extension ids are case-insensitive); a file naming them all is left byte-for-byte alone; one
 *  missing some is re-read as JSON and gains them, and one that is not plain JSON is left with a
 *  warning rather than clobbered. */
export const EDITOR_EXTENSION_ID = "dreamteamer.dreamteamer-vscode"

export const EDITOR_RECOMMENDATIONS = [EDITOR_EXTENSION_ID, "Anthropic.claude-code"]

/** Never a namespace: it would give the default namespace a second, prefixed spelling. */
export const RESERVED_NAMESPACES = new Set(["default"])

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

// ---- value tokens ------------------------------------------------------------------
// A filter value is a literal or one of VALUE_TOKENS, resolved when the filter is evaluated against
// the evaluating machine's clock and zone, so a saved view "due before today" stays true tomorrow.
// `$today` is the local calendar date (the shape a `date` field holds); `$now` is the local instant
// with its offset (the shape a `datetime` field holds). A token is the WHOLE value: `$100` is a
// literal, `$yesterday` is an unknown token. compile and `--where` refuse an unknown token through
// `unknownTokens`; at evaluation one narrows to nothing, the same posture as an unknown operator.
export const VALUE_TOKENS = ["$today", "$now"]

export const TOKEN = /^\$[A-Za-z_]\w*$/

export const KNOWN_OPERATORS: ReadonlySet<string> = new Set([
  "_eq",
  "_neq",
  "_ieq",
  "_nieq",
  "_lt",
  "_lte",
  "_gt",
  "_gte",
  "_in",
  "_nin",
  "_null",
  "_nnull",
  "_empty",
  "_nempty",
  "_contains",
  "_ncontains",
  "_icontains",
  "_starts_with",
  "_istarts_with",
  "_ends_with",
  "_iends_with",
  "_between",
  "_nbetween",
  "_regex",
  "_and",
  "_or",
])

/** The fields every collection has. `created` is stored (engine-written); `id` and `last_modified` are
 *  computed on read. */
export const INJECTED_FIELDS = {
  id: { type: "string", title: "Id", virtual: true, description: "The record's path inside its collection." },
  created: {
    type: "datetime",
    title: "Created",
    derived: true,
    description:
      "When the record was first written. Stamped by the engine at add; read from the id's date or the first commit for a record written before it existed.",
  },
  last_modified: {
    type: "datetime",
    title: "Last modified",
    virtual: true,
    description: "When the record was last committed, from git.",
  },
}
