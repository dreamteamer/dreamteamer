import path from "node:path"
import { envContext } from "../../workspace/envContext.ts"
import { renderTemplate } from "../../workspace/renderTemplate.ts"
import type { Workspace } from "../../types.ts"
import type { RepoFields } from "../types.ts"

export function repoPath(ws: Workspace, fields: RepoFields): string {
  const ctx = envContext(ws)
  if (fields.path) return path.resolve(ws.root, renderTemplate(fields.path, ctx))
  const base = renderTemplate(ws.pkg.dreamteamer?.repos_path ?? "projects", ctx)
  const tail = fields.identity ? path.join(fields.identity, fields.name) : fields.name
  return path.resolve(ws.root, base, tail)
}
