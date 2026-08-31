# what changed — record events derived from git

**core principle:** record events are never observed live — they are **derived from git
history**. a closed laptop loses nothing, every derivation is auditable and replayable forever,
and history IS the queue: there is no events file, and there never should be.

```bash
dt changes                        # what the last commit changed (--since HEAD~1)
dt changes --since <sha|YYYY-MM-DD>
dt changes --json
```

per record it reports the collection, the id and one of `item-added` / `item-updated` /
`item-removed`, grouped by collection with counts. **read-only by construction** — no cursor,
nothing stored, so running it twice is free and running it wrong costs nothing.

## when to use

the operator asks what changed or what they missed; you are reconciling after a batch of edits or
a bulk rewrite; you want to know what a range of commits did to the *data*. **not for** ordinary
"show me the diff" questions — plain `git log` / `git diff` is better — not for reading or
writing individual records (`records.md`), and not for UNCOMMITTED writes: it diffs commits, so
pending records are invisible to it (`dt commit --dry-run` shows those).

## the mechanism — enough to trust its edges

1. it covers **every repo that holds records**: each compiled descriptor's `storage.path`,
   grouped per repo (a module can own its records). a changed path that matches no descriptor is
   **skipped** — source and runtime churn are not data events — and runtime entities never
   appear.
2. `--since` takes a sha or a date. a sha is resolved to its commit DATE in the workspace repo
   (a sha means nothing in another repo), and each repo then resolves that date against its own
   history; a repo younger than the date reports everything in it as added. ⚠ a bare date is
   pinned to **midnight** deliberately — git's own approxidate fills missing fields from the
   current clock, so the same command would answer differently morning and evening (measured).
3. the git status letter becomes the event: `A` → added, `M` → updated, `D` → removed. **a
   rename emits removed + added** — there is deliberately no `item-renamed`, because the id IS
   the path and a moved record is a different record to any consumer.

## if you are ever asked to automate on top of this

this derivation is the surviving half of a removed automation layer (its run-records went unused:
one workflow, nine runs, seven abandoned, in three days). the lessons it left: **never store an
event queue** — a queue drifts from reality, history cannot; make every evaluator **idempotent
over a range** (the old design keyed on `trigger + item + commit` — reuse that shape); and **a
migration is not a data event** — a bulk rewrite looks like N added records, so scope past it
rather than run over it.

## common mistakes

| mistake | reality |
|---|---|
| hand-rolling the diff + path mapping | `dt changes` is the mechanism; a hand-roll misses folder-shape records, per-repo grouping and the rename split |
| writing an events file to "remember" what changed | history is the record; anything you write can drift from it |
| reading the output as a to-do list | it says what changed, not what it means — the judgment is yours |
