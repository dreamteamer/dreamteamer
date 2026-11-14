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
