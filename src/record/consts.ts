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

export const FILTERS = ["date", "datetime", "slug", "pad", "basename"]

/** A record format's file extension, defined once — review finding 11 found it copied in 2–4 places, diverging. */
export const EXT: Record<string, string> = { md: ".md", yaml: ".yaml", json: ".json" }

/** How big a `format: binary` record may be before `check` says something, when its collection does not
 *  say otherwise. 200 KB fits an icon, a logo, a small illustration or a compressed photo, and does
 *  not fit the video someone will one day try to make a record. */
export const MAX_RECORD_BYTES = 204800

export const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3})\d*)?\s*(Z|[+-]\d{2}:?\d{2})?$/i

/** Never a namespace: it would give the default namespace a second, prefixed spelling. */
export const RESERVED_NAMESPACES = new Set(["default"])

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
