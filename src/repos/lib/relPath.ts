import path from "node:path"

// A `repos` record declares a related git repo and NOTHING about the schema — the other half of
// what git_modules fuses together. Modules stay in package.json because compile can't read records
// until they're restored (no .dreamteamer → no schemas → no readable records); attached repos have
// no such constraint, so they get to be data.

export const relPath = (root: string, p: string): string => path.relative(root, p) || "."
