import type { Workspace } from "../types.ts"

/** The workspace's direct dependencies, sorted — what `npm install` is responsible for. */
export const declaredDeps = (ws: Workspace): string[] =>
  Object.keys({ ...ws.pkg?.dependencies, ...ws.pkg?.devDependencies }).sort()
