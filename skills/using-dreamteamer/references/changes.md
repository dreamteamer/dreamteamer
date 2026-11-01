# what changed — the uncommitted state and the commits, per record

**core principle:** record changes are never observed live — they are **read off git**: the
working tree against HEAD for what is written and not committed, and the history for what was
committed. a closed laptop loses nothing, every answer is auditable and replayable, and history IS
the queue: there is no events file, no mark file and no cursor, and there never should be.

```bash
dt changes                        # what is written and not committed — every repo, each against its own HEAD
dt changes --since <sha|YYYY-MM-DD>   # everything since then: the commits AND the uncommitted state
dt changes --since HEAD~1         # what 0.41.0's bare `dt changes` answered: the last commit, plus anything pending
dt changes --json
dt changes -w <layer>             # the same, run IN a record layer (its own paths, its own HEAD)
```

per record it reports `change` — `created` / `updated` / `deleted` — the `ref`, the
workspace-relative `path`, the `repo` it lives in, the record `layer` it was read from (empty for
the workspace and for a module's own clone) and whether it is `committed`. the human output's FIRST
LINE is the report line a reply ends with (`SKILL.md`, "a reply that wrote records ends with the
record report"), then one row per record, then the count. `dt commit` prints the same block for
what it just published. **read-only by construction** — nothing stored, so running it twice is free
and running it wrong costs nothing.

`--json` is `{ since, head, events, collections }`: `events` one entry per record (carrying 0.41.0's
`type` — `item-added` / `item-updated` / `item-removed` — beside `change`, so an older reader keeps
working), `collections` one count row per collection and layer.

## when to use

before replying after any write (the record report); the operator asks what changed or what they
missed; you are reconciling after a batch of edits or a bulk rewrite; you want to know what a range
of commits did to the *data*. **not for** ordinary "show me the diff" questions — plain `git log` /
`git diff` is better — and not for reading or writing individual records (`records.md`).

## the mechanism — enough to trust its edges

1. it covers **every repo that holds records**: each compiled descriptor's roots — the write root
   and every record layer's — grouped per repo (a module can own its records). a changed path that
   matches no descriptor is **skipped** — source and runtime churn are not data events — and
   runtime entities never appear.
2. the uncommitted half is the same `git status` sample `dt commit` publishes from and `dt status`
   counts, so the three can never disagree. it cannot say WHICH SESSION wrote a pending record —
   git does not know — which is why the report rule says to keep only your own.
3. `--since` takes a sha or a date. a sha is resolved to its commit DATE in the workspace repo
   (a sha means nothing in another repo), and each repo then resolves that date against its own
   history; a repo younger than the date reports everything in it as created. ⚠ a bare date is
   pinned to **midnight** deliberately — git's own approxidate fills missing fields from the
   current clock, so the same command would answer differently morning and evening (measured).
4. the two halves fold per record: created then deleted inside the window is not reported (it
   existed at neither end); created then edited is still created; deleted then re-created is an
   update; a record moved inside one repo (`dt relocate`) is one update at its new path.
5. **a rename is deleted + created** — there is deliberately no `renamed`, because the id IS the
   path and a moved record is a different record to any consumer.

## if you are ever asked to automate on top of this

this derivation is the surviving half of a removed automation layer (its run-records went unused:
one workflow, nine runs, seven abandoned, in three days). the lessons it left: **never store an
event queue** — a queue drifts from reality, history cannot; make every evaluator **idempotent
over a range** (the old design keyed on `trigger + item + commit` — reuse that shape); and **a
migration is not a data event** — a bulk rewrite looks like N created records, so scope past it
rather than run over it.

## common mistakes

| mistake | reality |
|---|---|
| writing the record report from memory of your `✔` lines | `dt changes` measures it; memory misses a script's writes and a hand-edit |
| reporting every row `dt changes` prints | the uncommitted state is shared with other sessions — keep only your own writes |
| an empty report when nothing was written | nothing written, nothing appended |
| expecting bare `dt changes` to show the last commit | since 0.42.0 it is the uncommitted state; `--since HEAD~1` adds the last commit |
| hand-rolling the diff + path mapping | `dt changes` is the mechanism; a hand-roll misses folder-shape records, layers, per-repo HEADs and the rename split |
| writing an events file to "remember" what changed | history is the record; anything you write can drift from it |
| reading the output as a to-do list | it says what changed, not what it means — the judgment is yours |
