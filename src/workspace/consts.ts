import { type StdioOptions } from "node:child_process"

/** The one command that converts a workspace to descriptor format v2. */
export const CONVERTER = "node node_modules/dreamteamer/dist/scripts/migrate-descriptors-v2.js --root ."

export const EXTENSION_API = 1

/** The keys a package.json `dreamteamer` block may carry — the workspace's and a module's alike. */
export const MANIFEST_KEYS = [
  "title",
  "description",
  "workspace_module",
  "data_path",
  "namespaces",
  "vars",
  "env",
  "auto_commit",
  "harnesses",
  "git_modules",
  "disable",
  "local_assets",
  "postinstall",
  "gitignore_runtime_folder",
  "repos_path",
  "dependencies",
  "peer_collections",
  "owns_data",
  "engine",
  "extension",
  "ignore",
  "provides",
  "setup",
]

export const SETUP_VERSION = 1

export const INPUT_KINDS = ["string", "path", "rows", "secret-path"]

export const CHECK_STATUSES = ["ready", "configured", "unverified", "missing", "blocked"]

export const ENV_KEY = /^[A-Z][A-Z0-9_]*$/

export const KINDS: readonly string[] = [
  "collections",
  "skills",
  "agents",
  "commands",
  "command-bindings",
  "ui-views",
  "mixins",
]

export const KNOWN_HARNESSES = ["claude-code", "codex", "pi", "gemini-cli", "cursor"]

// ⚠ THE VALUES ARE A CONTRACT, not an implementation detail: every managed root file on every disk
// already carries these two exact strings, and a tool that merges branches (a worktree
// extension's `land`) classifies a conflict by asking whether its hunks lie between them. Changing a byte orphans
// every block ever written and silently reclassifies a generated conflict as the operator's own prose.
export const BEGIN = "<!-- dreamteamer:begin (generated — do not edit inside this block) -->"

export const END = "<!-- dreamteamer:end -->"

// A SECOND managed block, deliberately not folded into the orientation one. Separate delimiters
// keep the orientation block's asserted size budget meaningful, and let `dreamteamer.md` be removed
// on its own without the removal touching anything generated from the schema.
export const INSTRUCTIONS_BEGIN = "<!-- dreamteamer:instructions:begin -->"

export const INSTRUCTIONS_END = "<!-- dreamteamer:instructions:end -->"

/** A view's display: the collection's four sub-blocks, with `nav.title` because a view has no
 *  descriptor title of its own, and `options` on the record page as well as the list. */
export const VIEW_DISPLAY: Record<string, string[]> = {
  nav: ["title", "icon", "order"],
  list: ["layout", "columns", "sort", "options"],
  record: ["layout", "subtitle", "badge", "color_by", "options"],
  form: ["sections"],
}

/** Layout options that take a FIELD, named for the role it plays; and the ones that take a template. */
export const FIELD_OPTIONS = ["color_by", "group_by", "lanes_by", "start", "end", "lat", "lng"]

export const TEMPLATE_OPTIONS = ["card_title", "bar_title", "group_title", "group_summary"]

export const BUILTIN_FIELDS = ["id", "created", "last_modified"]

/** The top-level keys a v2 descriptor may carry, in canonical order. */
export const V2_KEYS = [
  "name",
  "title",
  "singular",
  "record_title",
  "description",
  "use_when",
  "internal",
  "sensitive",
  "storage",
  "ids",
  "mixins",
  "overlay",
  "fields",
  "constraints",
  "display",
]

// channel -> the directory the operator knows it by (used in shadow warnings, and it IS the
// `location` field's vocabulary — see collections/modules.collection.yaml. Keeping the export name
// on purpose: renaming a symbol under src/ is a cross-repo change, and this one buys nothing.)
export const CHANNEL_LABEL: Record<string, string> = { inline: "modules", git: "git_modules", npm: "node_modules" }

// ⚠ A MANAGED MARKER INSIDE `dreamteamer.md` IS A REFUSAL, not something to escape around.
// The file is rendered VERBATIM into a managed block, and `writeBlock` finds that block by the FIRST
// occurrence of its begin marker anywhere in the file — so a marker quoted inside the rendered text
// is found before the real delimiter. Both directions were measured on a fixture:
//
//   - quoting the ORIENTATION pair: the orientation pass rewrites the quoted region, the instructions
//     pass that runs immediately after restores it from source, and the real orientation block is
//     never touched again. It silently keeps describing the schema of the day it was written, while
//     `compile` exits 0 and `status` reports the runtime fresh.
//   - quoting the INSTRUCTIONS end marker: the block is closed at the quote and a second end line is
//     appended, so all three committed root files grow by ~40 bytes and one duplicated line per
//     compile, without ever reaching a fixed point.
//
// Escaping the markers on the way out is the alternative, and it is not one: the whole promise of
// this file is that what was written is what every agent reads, and an escaped marker is not that.
// A rule ABOUT the block describes it instead of quoting it.
/** The one hand-written root source. Named once: `compile` reads it and `staleness` looks for it. */
export const INSTRUCTIONS_SOURCE = "DREAMTEAMER.md"

export const EXIT = { done: 0, failed: 1, usage: 2, needsInput: 3 }

// Same rule as store.js: a git failure we CATCH must not also print git's own error on top of the
// clean message we throw. stdout stays piped because some callers read it.
export const GIT_QUIET: StdioOptions = ["ignore", "pipe", "ignore"]

// git calls whose failure we CATCH must not print git's own error: execFileSync forwards the
// child's stderr to ours unless told otherwise, so a handled "not a git repository" still
// reached the user's terminal. stdout stays piped because we read it.
export const QUIET: StdioOptions = ["ignore", "pipe", "ignore"]
