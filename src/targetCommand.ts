import type { Workspace, Flags } from "./types.ts"
import { Store } from "./store/Store.ts"
import { parseArgs } from "./lib/parseArgs.ts"
import { refuseUnknownFlags } from "./lib/refuseUnknownFlags.ts"
import { isEntityKind } from "./lib/isEntityKind.ts"
import { recordsCommand } from "./records/recordsCommand.ts"

type Handler = (
  ws: Workspace,
  store: Store,
  collection: string,
  verb: string,
  flags: Flags,
  pos: string[]
) => number | null

const FIELD_VERBS = new Set(["add-field", "set-field", "rm-field", "rename-field", "rename-value"])

/**
 * The system-verb handlers that COULD claim this call, in the order they are tried, each imported
 * only when it might: a record verb on a domain collection — most launches — loads none of them.
 *
 * ⚠ This narrows by the collection name (and the field verbs) alone, the first condition of each
 * handler's own guard; the handler still decides, and returns null to fall through to the records
 * handler. A handler that starts claiming a NEW collection name must be added here too, or its calls
 * go to the records handler.
 */
async function candidates(store: Store, collection: string, verb: string): Promise<Handler[]> {
  const out: Promise<Handler>[] = []
  if (collection === "collections" || FIELD_VERBS.has(verb))
    out.push(import("./collections/collectionsCommand.ts").then(m => m.collectionsCommand))
  if (collection === "commands") out.push(import("./records/nextCommand.ts").then(m => m.nextCommand))
  if (collection === "ui-views") out.push(import("./ui-views/uiViewsCommand.ts").then(m => m.uiViewsCommand))
  if (collection === "modules") out.push(import("./modules/modulesCommand.ts").then(m => m.modulesCommand))
  if (collection === "repos") out.push(import("./repos/reposCommand.ts").then(m => m.reposCommand))
  if (isEntityKind(store, collection)) out.push(import("./entities/entitiesCommand.ts").then(m => m.entitiesCommand))
  return Promise.all(out)
}

export async function targetCommand(ws: Workspace, collection: string, verb: string, args: string[]): Promise<number> {
  const store = new Store(ws)
  const { flags, pos } = parseArgs(args)
  refuseUnknownFlags(store, collection, verb, flags)

  // system verbs: source writes, never the runtime
  // These MUST come before the generic records handler: their collections are system-stored, so the
  // ordinary record path refuses them ("… are system sources") and always would.
  for (const handler of await candidates(store, collection, verb)) {
    const code = handler(ws, store, collection, verb, flags, pos)
    if (code !== null && code !== undefined) return code
  }
  return recordsCommand(ws, store, collection, verb, flags, pos)
}
