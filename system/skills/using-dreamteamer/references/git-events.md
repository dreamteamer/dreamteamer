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

Until 2026-07-31 this mechanism was the front half of `dt sync`, which also matched
`workflow-triggers` records, **created `workflow-runs`**, and advanced a per-evaluator cursor. That
whole layer was removed: measured over three days it had produced 1 workflow record and 9 runs all from
a single burst, **7 of them abandoned mid-flight**, against a cursor that had not advanced — while the
work it was meant to automate was being done by a chain of commands a person runs.

The derivation survived because it is the half that was actually used, for catch-up. Worth keeping from
that design if automation is ever rebuilt:

- **Never store an event queue.** A queue drifts from reality; history cannot.
- **Any evaluator must be idempotent over a range** — re-running must not act twice. The old design
  keyed that on `trigger + item + commit`, which is the shape to reuse.
- **A migration is not a data event.** A bulk rewrite looks like N added records to git, so anything
  acting on events must be scoped past it rather than run over it.

## common mistakes

| mistake | reality |
|---|---|
| hand-rolling the diff + path mapping | `dt changes` is the mechanism; a hand-roll misses folder-shape records and the rename split |
| treating any changed path as a record | only paths matching a descriptor's `storage.path` + suffix + codec are records |
| diffing the whole tree | scope to `data/` + `state/`; source and runtime churn are not item events |
| writing an events file to "remember" what changed | history is the record; anything you write can drift from it |
| reading `dt changes` output as a to-do list | it says what changed, not what it means — the judgement is yours |
