# detecting data changes via git

**Core principle:** record events are never observed live — they are **derived from git history**. A
closed laptop loses nothing, and every derivation is auditable and replayable forever. History IS the
queue; there is no events file, and there never should be.

## the verb

```bash
dt changes                      # since the last commit
dt changes --since <sha>        # since any commit
dt changes --json               # for a program
```

Per record it reports the collection, the id and one of `item-added` / `item-updated` /
`item-removed`, grouped by collection with counts. **Read-only by construction** — there is no cursor
to advance and nothing is stored, so running it twice is free and running it wrong costs nothing.

## when to use

The operator asks what changed or what they missed; you are reconciling after a batch of edits or a
bulk rewrite; you want to know what a range of commits actually did to the data.

**Not for:** ordinary "show me the diff" questions — plain `git log` / `git diff` is better. Not for
reading or writing individual records (`references/records.md`).

## the mechanism

1. **Diff** — `git diff --name-status <sha>..HEAD -- data/ state/`.
2. **Map** — each path maps to a collection via the compiled descriptors' `storage.path`
   (longest-prefix match; the suffix + codec must also match a record file, and folder-shape
   collections match on their `entry`). The id is the path inside the collection folder minus
   `.<suffix>.<ext>`. **A changed path that matches no descriptor is not a record** and is skipped —
   source and runtime churn are not data events.
3. **Classify** — the git status letter becomes the event: `A` → added, `M` → updated, `D` → removed.
   **A rename emits removed + added**; there is deliberately no `item-renamed` event, because the id IS
   the path and a moved record is a different record as far as any consumer is concerned.

## what this used to be, and why the rest went

Until 2026-07-31 this was the front half of `dt sync`, which also created `workflow-runs` and advanced
a per-evaluator cursor. That layer was removed — over three days it produced 1 workflow record and 9
runs from one burst, 7 abandoned mid-flight, against a cursor that never advanced. Catch-up is the
half that was actually used, so the derivation survived. If automation is ever rebuilt: **never store
an event queue** (a queue drifts from reality; history cannot), **make every evaluator idempotent over
a range** (the old design keyed that on `trigger + item + commit` — reuse that shape), and remember
that **a migration is not a data event** — a bulk rewrite looks like N added records to git, so scope
past it rather than run over it.

## common mistakes

| mistake | reality |
|---|---|
| hand-rolling the diff + path mapping | `dt changes` is the mechanism; a hand-roll misses folder-shape records and the rename split |
| writing an events file to "remember" what changed | history is the record; anything you write can drift from it |
| reading `dt changes` output as a to-do list | it says what changed, not what it means — the judgement is yours |
