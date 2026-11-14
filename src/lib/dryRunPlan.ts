/**
 * THE ONE PLAN PRINTER, for every verb that moves records or clears values — one shape, `records N ·
 * refs M · descriptors K · values cleared V`, because a reader comparing two dry runs must not have
 * to work out whether a missing term means zero or means "this verb does not count that".
 *
 * ⚠ FOUR OF THE SIX SPELLINGS DOCUMENTED `--dry-run` AND EXECUTED ANYWAY, and the self-commit made
 * it durable: `dt rm collections/widgets --dry-run --force` printed "✔ removed collection widgets",
 * deleted the source and committed it, at exit 0, against a `dt help` that spells `rm <system>/<id>
 * [--force] [--dry-run]` verbatim. `rm modules/<id>` was the ONE that honoured it. A flag a verb
 * advertises and ignores is worse than one it does not have — the operator's whole reason for typing
 * it is that they are not sure yet.
 *
 * It counts only what it can count WITHOUT doing the op; an unmeasured term is stated as such in
 * `extra` rather than guessed at, per `rename collections`' dry run.
 */
export function dryRunPlan(
  what: string,
  plan: { records?: number; refs?: number; descriptors?: number; cleared?: number },
  extra?: unknown[]
) {
  console.log(`dry run — dreamteamer ${what} would:`)
  console.log(
    `  records ${plan.records ?? 0} · refs ${plan.refs ?? 0} · descriptors ${plan.descriptors ?? 0} · values cleared ${plan.cleared ?? 0}`
  )
  for (const line of extra ?? []) if (line) console.log(`  ${line}`)
  return 0
}
