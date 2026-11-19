import { findWorkspace } from "./workspace/findWorkspace.ts"
import { loadExtensions } from "./extensions/loadExtensions.ts"
import { KINDS, KNOWN_HARNESSES } from "./compile/consts.ts"
import { DERIVED_KINDS } from "./runtime/consts.ts"
import { CORE_VERBS } from "./coreVerbs.ts"
import type { LoadedExtension, Workspace } from "./types.ts"

/**
 * The workspace at (or above) `start`, with its declared extensions ACTIVATED against this engine.
 * The handle every other call takes: `{ root, pkg, extensions }`. Performs no compile, install,
 * network call or write, and never changes the process cwd.
 *
 * Its own file, not api.ts, because every CLI verb opens a workspace and api.ts is the whole engine:
 * the public API an extension is activated against is imported only when there is an extension.
 */
export async function openWorkspace(
  start: string = process.cwd()
): Promise<Workspace & { extensions: LoadedExtension[] }> {
  const ws = findWorkspace(start) as Workspace & { extensions: LoadedExtension[] }
  ws.extensions = await loadExtensions(ws, () => import("./api.ts"), {
    verbs: CORE_VERBS,
    kinds: [...KINDS, ...DERIVED_KINDS],
    harnesses: KNOWN_HARNESSES,
  })
  return ws
}
