import type { Workspace } from "./types.ts"
import { Store } from "./record/Store.ts"
import { parseArgs } from "./lib/parseArgs.ts"
import { refuseUnknownFlags } from "./lib/refuseUnknownFlags.ts"
import { collectionsCommand } from "./collections/collectionsCommand.ts"
import { nextCommand } from "./records/nextCommand.ts"
import { uiViewsCommand } from "./ui-views/uiViewsCommand.ts"
import { modulesCommand } from "./modules/modulesCommand.ts"
import { reposCommand } from "./repos/reposCommand.ts"
import { entitiesCommand } from "./entities/entitiesCommand.ts"
import { recordsCommand } from "./records/recordsCommand.ts"

export function targetCommand(ws: Workspace, collection: string, verb: string, args: string[]) {
  const store = new Store(ws)
  const { flags, pos } = parseArgs(args)
  refuseUnknownFlags(store, collection, verb, flags)

  // ---- system verbs: source writes, never the runtime ----------
  // These MUST come before the generic switch: their collections are system-stored, so the
  // ordinary record path refuses them ("… are system sources") and always would.
  return (
    collectionsCommand(ws, store, collection, verb, flags, pos) ??
    nextCommand(ws, store, collection, verb, flags, pos) ??
    uiViewsCommand(ws, store, collection, verb, flags, pos) ??
    modulesCommand(ws, store, collection, verb, flags, pos) ??
    reposCommand(ws, store, collection, verb, flags, pos) ??
    entitiesCommand(ws, store, collection, verb, flags, pos) ??
    recordsCommand(ws, store, collection, verb, flags, pos)
  )
}
