import path from "node:path"
import { execFileSync } from "node:child_process"
import type { EventType } from "./types.ts"
import { commitArg } from "../record/commitArg.ts"
import { pathToRecord } from "../record/pathToRecord.ts"
import { storageOf } from "../record/storageOf.ts"
import type { Descriptors } from "../types.ts"

type RecordEvent = { type: EventType; collection: string; id: string; path: string; repo: string }

/** Record events between two points, across EVERY repo that holds records. `from` is a sha or a
 *  date — a sha is meaningless in another repo, so it is resolved to its commit DATE and each
 *  repo then resolves that date to its own sha. Still cursor-less and stores nothing, so it can
 *  be run twice with no consequence. Every ROOT of a collection is sampled — the write root and
 *  each record layer's — and an event carries the repo it was read from; sampling the write root
 *  alone answered `events: []` for a commit made in a layer's clone. */
export function deriveEvents(root: string, descriptors: Descriptors, from: string, to = "HEAD"): RecordEvent[] {
  commitArg(to)
  const byRepo = new Map<string, string[]>()
  for (const d of descriptors.values()) {
    if (storageOf(d).runtime) continue // runtime entities aren't item events
    if (storageOf(d).external || storageOf(d).unavailable) continue // an env-pointed root: no repo here holds its history
    for (const { path: p, repo } of storageOf(d).roots) {
      if (!p) continue
      if (!byRepo.has(repo)) byRepo.set(repo, [])
      if (!byRepo.get(repo).includes(p)) byRepo.get(repo).push(p)
    }
  }
  const when = asDate(root, from)
  const events: RecordEvent[] = []
  for (const [repo, dirs] of byRepo) {
    const cwd = path.resolve(root, repo)
    const prefix = repo === "." ? "" : `${repo}/`
    // descriptors carry WORKSPACE-relative paths; git in the module repo wants its own
    const relDirs = dirs.map(d => (prefix && d.startsWith(prefix) ? d.slice(prefix.length) : d))
    // a repo whose history STARTS after the baseline (the agentlog clone is younger than the
    // workspace) has no commit to diff against — but every record in it IS new since then,
    // so fall back to the empty tree rather than silently contributing zero events
    const fromSha = shaAt(cwd, when) ?? EMPTY_TREE
    let out: string
    try {
      out = execFileSync(
        "git",
        ["diff", "--name-status", "-z", "--end-of-options", `${fromSha}..${to}`, "--", ...relDirs],
        { cwd }
      ).toString()
    } catch {
      continue
    }
    events.push(...parseNameStatus(out, prefix, descriptors, repo))
  }
  return events
}

// git's own "no parent" object — the diff baseline for a repo younger than the requested date
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** A sha or a date in → an ISO instant. A sha is resolved in the WORKSPACE repo, since that is
 *  the only repo a caller could have got one from. */
function asDate(root: string, from: string): string {
  // a BARE date is pinned to midnight: git's approxidate fills unspecified fields from NOW, so
  // `--before=2026-08-01` means 2026-08-01 at the current clock time and the same command
  // answers differently in the morning and the evening (measured, 2026-08-03)
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) return `${from}T00:00:00`
  if (/^\d{4}-\d{2}-\d{2}/.test(from)) return from
  try {
    commitArg(from, true) // inside the try: a refused revision answers the sentence below
    return execFileSync("git", ["show", "-s", "--format=%cI", "--end-of-options", from], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
  } catch {
    throw new Error(`--since "${from}" is neither a date (YYYY-MM-DD) nor a commit in this workspace`)
  }
}

function shaAt(cwd: string, when: string): string | null {
  try {
    return (
      execFileSync("git", ["rev-list", "-1", `--before=${when}`, "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || null
    )
  } catch {
    return null
  }
}

/** `git diff --name-status -z` output → record events. `prefix` turns each REPO-relative path
 *  into the WORKSPACE-relative one pathToRecord expects; without it every module-owned path
 *  matches nothing and the repo silently contributes zero events. Note the -z layout: unlike
 *  `status --porcelain -z`, the status letter and the path are SEPARATE NUL-terminated chunks. */
function parseNameStatus(out: string, prefix: string, descriptors: Descriptors, repo: string): RecordEvent[] {
  const parts = out.split("\0").filter(s => s.length > 0)
  const events: RecordEvent[] = []
  const push = (type: EventType, relPath: string): void => {
    const rec = pathToRecord(descriptors, relPath)
    if (rec) events.push({ type, ...rec, path: relPath, repo })
  }
  for (let i = 0; i < parts.length;) {
    const status = parts[i++]
    const p1 = prefix + parts[i++]
    if (status.startsWith("R") || status.startsWith("C")) {
      const p2 = prefix + parts[i++]
      if (status.startsWith("R")) push("item-removed", p1)
      push("item-added", p2)
    } else {
      push(status[0] === "A" ? "item-added" : status[0] === "D" ? "item-removed" : "item-updated", p1)
    }
  }
  return events
}
