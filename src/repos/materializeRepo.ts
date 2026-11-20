import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import type { Workspace } from "../types.ts"
import { relPath } from "./lib/relPath.ts"
import { repoPath } from "./lib/repoPath.ts"
import { tryGit } from "../lib/git/tryGit.ts"
import type { RepoFields } from "./types.ts"

export function materializeRepo(
  ws: Workspace,
  id: string,
  fields: RepoFields
): { id: string; path: string; present: true; cloned: boolean; ref: string } {
  const dest = repoPath(ws, fields)
  const ref = fields.ref ?? "main"
  const rp = relPath(ws.root, dest)
  if (fs.existsSync(dest)) {
    // same contract as install(): warn on drift, never force-sync, never touch a dirty tree
    const head = tryGit(dest, ["rev-parse", "--abbrev-ref", "HEAD"])
    const dirty = tryGit(dest, ["status", "--porcelain"])
    if (head && head !== ref) {
      console.warn(`⚠ ${rp}: HEAD is ${head}, record says ${ref} — not touching it${dirty ? " (dirty)" : ""}`)
    }
    return { id, path: rp, present: true, cloned: false, ref: head ?? ref }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  console.log(`… cloning ${fields.url} → ${rp} (${ref})`)
  execFileSync("git", ["clone", "--branch", ref, fields.url, dest], { stdio: "inherit" })
  // NO npm install here: a prototype or app repo is not an npm module and
  // must never have `npm install` run in it as a side effect of being materialized.
  return { id, path: rp, present: true, cloned: true, ref }
}
