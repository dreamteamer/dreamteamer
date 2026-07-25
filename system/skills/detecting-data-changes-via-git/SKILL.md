---
name: detecting-data-changes-via-git
description: derive item-added/updated/removed events from git history (the git-ops mechanism behind triggers and catch-up)
---

# detecting data changes via git

**core principle:** item events are never observed live — they are **derived from git history**.
a closed laptop loses nothing, and every evaluation is auditable and replayable forever.

## automation is LIVE (deferral lifted — decision 38; was decision 11)

`dreamteamer sync` is the evaluator: it derives events since this evaluator's cursor, matches
enabled `workflow-triggers` records, **creates run records**, and advances the cursor — one
command, auditable, replayable. use the CLI, don't re-implement the mechanism by hand:

| do | how |
|---|---|
| evaluate + act | `dreamteamer sync` (or `POST /api/sync`) |
| preview without acting | `dreamteamer sync --dry-run` (cursor NOT advanced) |
| separate machine/process | `--evaluator <name>` — per-evaluator cursors in `state/cursors/` |
| see what a past range did | run records carry `trigger` + `commit` provenance |

run EXECUTION stays attended: sync creates the run; advancing its steps is
`executing-workflows`. resuming a `waiting` run whose gate task completed is still the
executor's job — sync surfaces it in the report, it does not advance steps. cron triggers
are declared but not yet evaluated (sync warns).

## when to use

the operator asks what changed / what they missed; you're reconciling after a batch of edits or
a migration; you need to understand what `dreamteamer sync` will do before running it.

**not for:** advancing a run (`executing-workflows`), reading or writing individual records
(`working-with-structured-data-files`), or ordinary "show me the diff" questions — plain `git
log`/`git diff` is fine for those.

## the mechanism (the full contract, for when slice 5 lands)

1. **cursor** — per-evaluator records in `state/cursors/<evaluator>.cursor.yaml` (decision 37;
   catch-up across evaluators = the min of their `last-evaluated` shas). committed like any record.
2. **diff** — `git diff --name-status <cursor>..HEAD` lists the changed files.
3. **map** — each path maps to a collection via the compiled descriptors' `storage.path`
   (longest-prefix match; the suffix + codec must match a record file). the id is the path
   inside the collection folder minus `.<suffix>.<ext>`.
4. **classify** — the git status letter becomes the event: `A` → item-added, `M` →
   item-updated, `D` → item-removed, `R` → rename (always emitted as removed + added —
   there is no item-renamed event).
5. **match** — events match enabled `workflow-triggers` records on `trigger-type` +
   `collection` (+ optional `filter` over the record's current fields); each NEW match creates a
   `workflow-runs` record. idempotency: the run's `trigger`+item+`commit` provenance is the
   dedupe key — re-evaluating a range creates nothing twice.
6. **advance** — write the new HEAD sha to the cursor, one commit.

## manual catch-up (the part you can run today)

```bash
cursor=$(awk '/^last-evaluated:/{print $2}' state/cursors/cli.cursor.yaml 2>/dev/null)
cursor=${cursor:-$(git rev-list --max-parents=0 HEAD)}
git diff --name-status "$cursor"..HEAD -- data/ state/
```

then summarize **per collection** for the operator: N added / M updated / K removed, plus the
notable items — new meetings, and completed gate tasks whose runs are still `waiting-on` them
(those are the ones the operator most likely wants resumed, by asking, not automatically).

## invariants

- events are reconstructible from history forever — **never store an event queue**.
- evaluation is idempotent: re-running over the same range must create nothing twice (run ids are
  deterministic per trigger + item + commit).
- missed crons on catch-up: run the latest once, skip the backlog (per-trigger configurable).

## common mistakes

| mistake | reality |
|---|---|
| re-implementing sync by hand (diff+match+add) | `dreamteamer sync` IS the mechanism — use it; hand-rolls skip dedupe and cursor discipline. |
| resuming a `waiting` run because you noticed its gate task done | sync creates runs; STEP advancement is `executing-workflows` — surface it there. |
| `git diff …$(grep last-evaluated …)..HEAD` inline | the pipeline exits 0 even when the file is missing, so `\|\|` never fires and you silently diff `HEAD..HEAD` (empty). use the two-line form above. |
| writing an events file / queue to "remember" | history IS the queue. a queue can drift; history can't. |
| advancing the cursor before reporting | if the report is wrong you've lost the range. report, then advance. |
| treating any changed path as a record | only paths matching a descriptor's `storage.path` + suffix + codec are records. |
| diffing the whole tree | scope to `-- data/ state/`; source and runtime churn aren't item events. |
