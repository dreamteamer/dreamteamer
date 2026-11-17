/**
 * The system collections whose records are what modules ship as files, not data in the workspace: a collection is a
 * descriptor, a module its package, a skill its folder. They are read from the model and never written here.
 */
export const SOURCE_KINDS = [
  "collections",
  "modules",
  "skills",
  "mixins",
  "agents",
  "commands",
  "command-bindings",
  "ui-views",
]
