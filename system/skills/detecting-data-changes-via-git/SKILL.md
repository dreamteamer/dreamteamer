---
name: detecting-data-changes-via-git
description: derive item-added/updated/removed events from git history (the git-ops mechanism behind triggers and catch-up)
---

# detecting data changes via git

**core principle:** item events are never observed live — they are **derived from git history**.
a closed laptop loses nothing, and every evaluation is auditable and replayable forever.

## ⚠ automation is DEFERRED (decision #11)

**no process may auto-create or auto-resume a workflow run from these events.** the operator's
call: nothing auto-executes while the engine is young. use this skill to **report**, never to
act:

| allowed today | forbidden today |
|---|---|
| manual catch-up: "what changed while I was away" | creating a `workflow-runs` record from a matched trigger |
| listing which enabled triggers *would* have matched | resuming a `waiting` run because its gate task went `done` |
| advancing the cursor after reporting | scheduling, polling, watching, or cron |

if the operator asks for automation, say it's deferred and offer the manual catch-up instead.
lifting the deferral is a decision-log entry, not a judgement call in the moment.

## when to use

the operator asks what changed / what they missed; you're reconciling after a batch of edits or a
migration; you're preparing slice 5 (trigger evaluation) and need the mechanism.

**not for:** advancing a run (`executing-workflows`), reading or writing individual records
(`working-with-structured-data-files`), or ordinary "show me the diff" questions — plain `git
log`/`git diff` is fine for those.

## the mechanism (the full contract, for when slice 5 lands)

1. **cursor** — `state/trigger-cursor.yaml` holds `last-evaluated: <sha>` (plus per-cron
   `last-run` stamps later). committed like any record; it doesn't exist yet in this workspace.
2. **diff** — `git diff --name-status <cursor>..HEAD` lists the changed files.
3. **map** — each path maps to a collection via the compiled descriptors' `storage.path`
   (longest-prefix match; the suffix + codec must match a record file). the id is the path
   inside the collection folder minus `.<suffix>.<ext>`.
4. **classify** — the git status letter becomes the event: `A` → item-added, `M` →
   item-updated, `D` → item-removed, `R` → rename (emit removed+added, or a single
   item-renamed when both sides map).
5. **match** — events match enabled `workflow-triggers` records on `trigger-type` +
   `collection`; each match *would* create a `workflow-runs` record. **deferred — report, don't
   create.**
6. **advance** — write the new HEAD sha to the cursor, one commit.

## manual catch-up (the part you can run today)

```bash
cursor=$(awk '/^last-evaluated:/{print $2}' state/trigger-cursor.yaml 2>/dev/null)
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
| creating a run because a trigger matched | automation is deferred. report the match; let the operator ask. |
| resuming a `waiting` run you noticed on your own | same rule — surface it, don't act on it. |
| `git diff …$(grep last-evaluated …)..HEAD` inline | the pipeline exits 0 even when the file is missing, so `\|\|` never fires and you silently diff `HEAD..HEAD` (empty). use the two-line form above. |
| writing an events file / queue to "remember" | history IS the queue. a queue can drift; history can't. |
| advancing the cursor before reporting | if the report is wrong you've lost the range. report, then advance. |
| treating any changed path as a record | only paths matching a descriptor's `storage.path` + suffix + codec are records. |
| diffing the whole tree | scope to `-- data/ state/`; source and runtime churn aren't item events. |
