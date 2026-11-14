import { FIELD_FLAGS } from "./FIELD_FLAGS.ts"

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
