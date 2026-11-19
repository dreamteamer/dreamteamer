import { ROWS_SHOWN } from "../changes/consts.ts"
import { Store } from "../store/Store.ts"
import { commitPending } from "../changes/commitPending.ts"
import { emit } from "../lib/emit.ts"
import { foldChanges } from "../changes/foldChanges.ts"
import { printChanges } from "../changes/printChanges.ts"
import { rowChanges } from "../changes/rowChanges.ts"
import { splitRef } from "../record/splitRef.ts"
import { openWorkspace } from "../openWorkspace.ts"

/**
 * the other half of `auto-commit: false` — record writes land on disk uncommitted, and
 * this publishes them. No pending file: the set is sampled from `git status`, so a
 * hand-edited record is indistinguishable from one the store wrote, which is the point.
 */
export async function commitCommand(rest: string[]): Promise<number> {
  const ws = await openWorkspace()
  const store = new Store(ws)
  const mi = rest.indexOf("-m")
  const message = mi > -1 ? rest[mi + 1] : undefined
  // bare args are TARGETS — a whole collection or a `<collection>/<id>` reference,
  // told apart in commit.js against the declared collections — minus the token `-m`
  // consumed as its subject
  const only = rest.filter((a, i) => !a.startsWith("-") && (mi === -1 || i !== mi + 1))
  const results = commitPending(store, { only, message, dryRun: rest.includes("--dry-run") })
  if (rest.includes("--json")) {
    emit(JSON.stringify(results, null, 2))
    return 0
  }
  if (!results.some(r => !r.outside)) console.log("nothing pending")
  const published = []
  for (const r of results) {
    // an env-pointed collection's folder is outside every repo here: kept, never committed, said
    if (r.outside) {
      console.log(
        `· ${r.outside}: ${r.repo} is outside every git repo here (storage.path ${r.template}) — its records are kept on this machine, never committed`
      )
      continue
    }
    if (r.blocked) {
      console.error(`✖ ${r.repo}: ${r.blocked} — ${r.rows.length} record(s) left uncommitted`)
      continue
    }
    if (r.failed) {
      console.error(`✖ ${r.repo}: ${r.failed} — ${r.rows.length} record(s) left uncommitted, nothing staged`)
      continue
    }
    if (r.pending) {
      console.error(
        `⚠ ${r.repo}: ${r.rows.length} record(s) left pending — ${r.pending}; run dreamteamer commit again once it is fixed`
      )
      continue
    }
    if (r.warning) console.warn(`⚠ ${r.repo}: ${r.warning}`)
    console.log(`✔ ${r.repo === "." ? "workspace" : r.repo}${r.sha ? ` ${r.sha}` : " (dry run)"} — ${r.subject}`)
    // what this repo published, for the ONE report block printed after every repo
    for (const c of rowChanges(store.descriptors, r.repo, r.rows)) published.push({ ...c, sha: r.sha })
    // Half a pair was published — name the records that finish it. `dt commit
    // <collection>` publishes exactly that collection by design, so this is an honest
    // report of what it left behind, not a failure: HEAD fails `check` until they land.
    if (r.leftPending?.length) {
      const n = r.leftPending.length
      console.warn(
        `⚠ ${n} relation partner(s) left pending — HEAD fails \`dreamteamer check\` until they are published:`
      )
      // CAPPED at the same ROWS_SHOWN as the rows above — this line was the one
      // unbounded list in the report, and 25 leftovers printed 25 refs on one line.
      // ⚠ But a truncated COMMAND is not a command, so the overflow is not "+ N more"
      // and nothing else: it names the collection-scoped form that does converge, and
      // what that costs (it sweeps whatever another session left pending there, which
      // is exactly why the record form is the default).
      console.warn(`    dreamteamer commit ${r.leftPending.slice(0, ROWS_SHOWN).join(" ")}`)
      if (n > ROWS_SHOWN) {
        const colls = [...new Set(r.leftPending.map(ref => splitRef(store.descriptors, ref).collection))].sort()
        console.warn(
          `    + ${n - ROWS_SHOWN} more — or ${colls.map(c => `dreamteamer commit ${c}`).join(" && ")}, which also publishes anything another session left pending there`
        )
      }
      // ⚠ AND IT CAN TAKE TWO COMMANDS, so say so rather than promise one. The command
      // above is planned by the same sweep every scoped commit runs, and a named
      // partner whose OTHER edge moved against a record this list does not carry is
      // refused as entangled — measured: `dt commit meetings` left one partner pending,
      // the printed `dt commit recordings/cap-zero` was refused over a second recording
      // sharing its topic, and the refusal named the pair that converges. Computing
      // that closure here would mean asking planSweep for strangers instead of
      // throwing on them, which is a redesign of the guard; naming the second step is
      // the honest half-measure.
      console.warn(
        "    (if that refuses as entangled, the refusal names the other pending records — add them to the same command)"
      )
    }
  }
  // the same block `dt changes` prints, for what was published — a dry run's rows are uncommitted
  if (published.length)
    printChanges(
      foldChanges(
        published.filter(c => c.sha),
        published.filter(c => !c.sha)
      )
    )
  return results.some(r => r.blocked || r.failed) ? 1 : 0
}
