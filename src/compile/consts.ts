/** The one command that converts a workspace to descriptor format v2. */
export const CONVERTER = "node node_modules/dreamteamer/dist/scripts/migrate-descriptors-v2.js --root ."

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
  "preset",
  "nav",
  "skills",
  "scripts",
]

/** A `dreamteamer.scripts` name — what `dt run <module> <name>` is typed with. */
export const SCRIPT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

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

/**
 * ⚠ THE VALUES ARE A CONTRACT, not an implementation detail: every managed root file on every disk
 * already carries these two exact strings, and a tool that merges branches (a worktree
 * extension's `land`) classifies a conflict by asking whether its hunks lie between them. Changing a byte orphans
 * every block ever written and silently reclassifies a generated conflict as the operator's own prose.
 */
export const BEGIN = "<!-- dreamteamer:begin (generated — do not edit inside this block) -->"

export const END = "<!-- dreamteamer:end -->"

/**
 * A SECOND managed block, deliberately not folded into the orientation one. Separate delimiters
 * keep the orientation block's asserted size budget meaningful, and let `dreamteamer.md` be removed
 * on its own without the removal touching anything generated from the schema.
 */
export const INSTRUCTIONS_BEGIN = "<!-- dreamteamer:instructions:begin -->"

export const INSTRUCTIONS_END = "<!-- dreamteamer:instructions:end -->"

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

/**
 * channel -> the directory the operator knows it by (used in shadow warnings, and it IS the
 * `location` field's vocabulary — see collections/modules.collection.yaml. Keeping the export name
 * on purpose: renaming a symbol under src/ is a cross-repo change, and this one buys nothing.)
 */
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

/**
 * The VS Code-family extensions for this workspace, as the editor learns of them: recommendations
 * in `.vscode/extensions.json`, which VS Code, Cursor and code-server all read on open and offer to
 * install. The studio extension, and beside it Claude Code, the agent a workspace's harness files are
 * compiled for. Written by `init` and kept current by `compile`, because a compiled workspace that
 * never names its editor left a first-run agent searching a registry for the id (measured 2026-09-24:
 * three install attempts, two of them into a directory the running editor did not read). An
 * existing file is MERGED, never replaced: an id the file already names anywhere — recommended, or
 * listed under `unwantedRecommendations` by an operator who declined it — counts as present, in any
 * case (extension ids are case-insensitive); a file naming them all is left byte-for-byte alone; one
 * missing some is re-read as JSON and gains them, and one that is not plain JSON is left with a
 * warning rather than clobbered.
 */
export const EDITOR_EXTENSION_ID = "dreamteamer.dreamteamer-vscode"

export const EDITOR_RECOMMENDATIONS = [EDITOR_EXTENSION_ID, "Anthropic.claude-code"]
