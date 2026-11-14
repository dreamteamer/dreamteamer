import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { planExports } from "./exports/planExports.ts"
import type { Store } from "./record/Store.ts"
import { EXPORTS_FILE } from "./record/consts.ts"
import { inProgress } from "./record/inProgress.ts"
import type { ExportChange } from "./record/types.ts"
import { exportsFacts } from "./runtime/exportsFacts.ts"

/** Write (and commit) each named repo's manifest; returns the exit code. */
export function runExports(
  store: Store,
  { layers = [], dryRun = false, json = false }: { layers?: string[]; dryRun?: boolean; json?: boolean } = {}
): number {
  const known = new Set((exportsFacts(store.root).layers ?? []).map(l => l.name))
  for (const l of layers)
    if (!known.has(l))
      throw new Error(`--layer ${l}: not a record layer of this workspace (have: ${[...known].join(", ") || "none"})`)
  const out = []
  for (const repo of layers.length ? layers : [null]) {
    const plan = planExports(store, repo)
    const before = fs.existsSync(plan.file) ? fs.readFileSync(plan.file, "utf8") : null
    const where = path.relative(store.root, plan.file)
    let committed: string | null = null
    let note: string | null = null
    if (!dryRun && before !== plan.text) {
      if (plan.text === null) fs.rmSync(plan.file)
      else fs.writeFileSync(plan.file, plan.text)
      // a merge, rebase, cherry-pick or revert refuses a one-path commit: write, and say how to finish
      const busy = inProgress(plan.dir)
      if (busy) note = `${busy} — the manifest is written; git add it and conclude it`
      else {
        const git = (args: string[]): string => {
          try {
            return execFileSync("git", args, { cwd: plan.dir, stdio: ["ignore", "pipe", "pipe"] })
              .toString()
              .trim()
          } catch (e) {
            throw new Error(
              `git ${args[0]} in ${path.relative(store.root, plan.dir) || "."} failed: ${String(e.stderr || e.message).trim()}`,
              { cause: e }
            )
          }
        }
        // an emptied manifest git never tracked: nothing to add, nothing to commit
        // an emptied manifest is un-staged with --ignore-unmatch: one git never tracked leaves nothing to commit
        git(
          plan.text === null
            ? ["rm", "--cached", "-q", "--ignore-unmatch", "--", EXPORTS_FILE]
            : ["add", "--", EXPORTS_FILE]
        )
        // back to what HEAD already holds (a hand edit undone), or never tracked: nothing to commit
        let same = false
        try {
          execFileSync("git", ["diff", "--cached", "--quiet", "HEAD", "--", EXPORTS_FILE], {
            cwd: plan.dir,
            stdio: "ignore",
          })
          same = true
        } catch {
          /* differs, or no HEAD yet */
        }
        if (!same) {
          git([
            "commit",
            "--only",
            "-q",
            "-m",
            `dreamteamer: exports — ${plan.entries} entr${plan.entries === 1 ? "y" : "ies"}`,
            "--",
            EXPORTS_FILE,
          ])
          committed = git(["rev-parse", "--short", "HEAD"])
        }
      }
    }
    const count = (k: ExportChange["kind"]): number => plan.changes.filter(c => c.kind === k).length
    out.push({
      repo,
      path: where,
      changed: before !== plan.text,
      changes: plan.changes,
      entries: plan.entries,
      committed,
      note,
    })
    if (json) continue
    console.log(
      before === plan.text
        ? `✔ ${repo ?? "this workspace"} · ${where} — exports manifest current (${plan.entries} entr${plan.entries === 1 ? "y" : "ies"})`
        : `${dryRun ? "·" : "✔"} ${repo ?? "this workspace"} · ${where} — ${count("add")} added, ${count("refresh") + count("fill")} changed, ${count("drop")} dropped (${plan.entries} entr${plan.entries === 1 ? "y" : "ies"})${dryRun ? " — dry run, nothing written" : committed ? ` · committed ${committed}` : ""}`
    )
    for (const c of plan.changes) console.log(`    ${c.kind} ${c.ref} — ${c.why}`)
    if (note) console.log(`⚠ ${note}`)
  }
  if (json) console.log(JSON.stringify({ dryRun, manifests: out }, null, 2))
  return 0
}
