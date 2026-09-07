# proofs — what a skill, a command or a script CLAIMS, and whether it still holds

A **proof** is a record that says what an artifact does, in a form the engine can run and judge.
`dt prove <id>` runs it and answers with an **exit code**, so a hook, a CI step or a session can
branch on the result without reading prose.

Two things make it different from a test suite. It is about an **artifact** — a skill, a command,
a command-binding, a module script — not about a function; and its subject is usually a
**procedure a session performs**, which no test runner can call. So a proof may stop, ask for the
action to be taken, and be re-run to judge the state that action left behind.

| the question | read |
|---|---|
| gate, live, or neither | the three kinds |
| the file and its keys | authoring a proof |
| what `where`, `count` and `{record}` mean | the predicate language |
| it stopped and printed PERFORM | the protocol |
| a proof that WRITES records | the sandbox |
| where the evidence lives | the ledger |
| what the number means | exit codes |
| coverage — what has no proof | reading the surface |
| proving a skill actually TEACHES | the eval layer |

## the three kinds

**A gate** is a static check with no record and no post-state: one or more `run` steps, judged on
their exit codes alone. `npm test`, a linter, a script's `--dry-run`, `dt check`. It is the cheapest
proof there is and the only one that needs nothing from the workspace's data. A gate takes no
`mode`, no `given` and no `expect` — compile refuses all three, because a gate that carried them
would be a live proof whose author believes something untrue about what runs.

**A live proof** runs against a real record and is judged by `expect`. It picks ONE record (`given`),
snapshots what it is about to measure, runs its steps, and then asks the store whether the world
changed the way the proof says it should. `mode: readonly` reads the workspace; `mode: writes`
mutates records and therefore runs in a throwaway worktree (see the sandbox). A live proof is where
a `perform` step belongs: "run `/close-note` on this note" is an instruction to an actor, and the
engine's job is to hold the before-state, hand over the instruction, and judge the after-state.

**An eval** is the third thing, and the engine deliberately does NOT run it. Whether a skill actually
teaches — whether a fresh session finds it, loads it and does the job right — is answered by running
sessions and scoring them, not by a filter over records. It is a PROCEDURE (below), with a scoring
sheet, run by a human or an agent. There is no `kind: eval`; `PROOF_KINDS` is `gate` and `live`, and
a workspace that pretended otherwise would be claiming an automated answer to a question nothing
automated can ask.

## authoring a proof

`modules/<module>/proofs/<id>.proof.yaml`. The filename is the id and must equal `name`. ⚠ **`dt add
proofs` is refused on purpose** — a proof is hand-authored, like a skill or a command, and the
refusal prints the path to write. Compile validates every key it interprets and FAILS on a proof it
cannot interpret; run `dt compile` after writing one.

```yaml
name: notes-close-cleanly            # required — equals the filename
about: [commands/close-note]         # required, ≥1 — skills/<id> · commands/<id> ·
                                     #   command-bindings/<id> · <module-id>/bin/<file>
kind: live                           # required — gate | live
mode: readonly                       # required on live, forbidden on gate — readonly | writes
description: closing a note sets its status and leaves the body alone.
external: false                      # optional — true excludes it from a bare --all
requires: { env: [HR_EXPORT_DIR], bin: [jq] }   # optional
given:                               # live only — exactly ONE of `where` or `fixture`
  collection: notes
  where: { status: { _eq: open } }
  pick: latest                       # `latest` (the collection's sort_field, DESC) or an explicit id
steps:                               # required — gate: ≥1 `run`; live: ≥1 of either
  - perform: /close-note {record}
expect:                              # live only, ≥1
  - { record: '{record}', where: { status: { _eq: done } } }
timeout: 120                         # optional — seconds per `run` step (default 120)
```

A gate is smaller, and most proofs in a healthy workspace are gates:

```yaml
name: hr-export-runs-clean
about: [hr/bin/export.mjs]
kind: gate
description: the export script runs end to end on the sample input and exits 0.
requires: { bin: [node] }
steps:
  - run: node modules/hr/bin/export.mjs --dry-run
  - run: node modules/hr/bin/export.mjs --check
```

A `writes` proof brings its own records, under `modules/<module>/proofs/fixtures/<proof-id>/`,
mirroring the workspace root — so `data/notes/fx-open.note.md` under that folder becomes
`notes/fx-open` inside the sandbox:

```yaml
name: closing-a-note-writes-the-field
about: [commands/close-note]
kind: live
mode: writes
given: { collection: notes, fixture: true, pick: fx-open }
steps:
  - perform: /close-note {record}
expect:
  - { record: '{record}', where: { status: { _eq: done } } }
  - { collection: notes, where: { status: { _eq: done } }, count: { _delta: 1 } }
```

| key | notes |
|---|---|
| `about` | what this proof is FOR. An unresolvable ref FAILS compile — a proof about nothing reports success forever |
| `kind` | `gate` (run steps only) or `live` (a record and expectations) |
| `mode` | live only. `writes` implies a sandbox unless `--here` |
| `requires` | `env` names must be declared in `dreamteamer.vars` or a module's `dreamteamer.env`; `bin` is looked up on PATH. Unmet ⇒ **UNAVAILABLE**, never FAIL — this machine cannot answer the question, which is not a fact about the artifact. ⚠ **names only** — no `.env` VALUE is ever read, compared or printed |
| `given` | exactly one of `where` (a live filter) or `fixture: true` (this proof's own records). `pick: latest` needs a `sort_field` on the collection; `pick: <id>` names one; **`pick: any` is refused** — a proof that picks arbitrarily proves something arbitrary. A fixture needs `pick: <id>` |
| `steps` | in order, until one fails or one asks for an actor |
| `expect` | live only. Four forms, below |
| `external` | for a proof needing the network, a credential or a mount. Invisible to `--all`; `--external` includes it |
| `timeout` | positive integer seconds, per `run` step |

## the predicate language

**`where` is the ordinary filter grammar** — the same one `dt list --where`, ui-views and binding
gates use, enumerated in `dt help` and described in `records.md`. Two proof-specific rules:

- **one hop, and a second is refused.** `{ owner: { name: { _eq: Ada } } }` resolves `owner` as a
  reference and tests the target's `name`. A third level is refused at compile —
  `where hops more than one reference (<field>.<hop>.<key>) — a proof filter hops at most one` —
  because the evaluator would silently narrow it to false. A proof that genuinely needs two hops
  writes its `expect` against the far collection.
- ⚠ **a nested key is a reference HOP, not a field comparison.** `{ a: { b: … } }` never means
  "compare `a` to `b`" — it means "resolve `a`, then test `b` on the target". When `a` is not a
  reference field, compile says so by name; at run time it would narrow to zero rows with no
  warning at all, which is the silent failure this whole kind exists to remove.

Compile also checks every literal against a CLOSED enum, so `status: { _eq: closed }` on a
`[open, done]` field is a compile error rather than a filter that matches nothing forever.

**Substitution.** Only two braces are substituted, in `run` and `perform` strings: `{record}` becomes
the picked record's reference (`notes/b`), and `{record.<field>}` becomes that field's value. ⚠
**Everything else reaches the shell as written** — `awk '{print $1}'`, `sed -n '1,3{p}'`, `jq '{a: .b}'`
and `mkdir -p x/{a,b}` are all correct steps, and refusing them was measured to be worse than the
typo the refusal was hunting. So the net is advisory: **compile WARNS** on an identifier-shaped brace
nobody substitutes (`⚠ proofs/x.proof.yaml: step 2 uses "{recrod}" — only {record} and {record.<field>} are
substituted; the rest reaches the shell as written`)
and the proof still compiles and still runs. `${…}` is untouched — that bracket is the resolver's
(`${env:FILES_FOLDER}`) and the shell's (`${HOME}`).

⚠ **A `path:` and every string literal inside an expectation's `where` are STRICT.** There the
ENGINE consumes the string, so an unknown brace THROWS instead of passing through:
`path: "{recrod}/out.txt"` would otherwise become a literal directory that does not exist and the
expectation would answer `exists false` — a FAIL naming the wrong cause; a filter literal fails the
same way one layer quieter, becoming a value the field never equals.

⚠ **A `where`'s literals are substituted BEFORE the filter runs, and that is what makes the
commonest live proof work at all.** `where: { owner: { _eq: "{record}" } }` counts the records
pointing back at the one this proof picked — the shape most collection-scope expectations take. It
is rendered in all three places a filter is evaluated: the `_delta` snapshot, the pre-check, and the
after-pass. ⚠ Inside a `_delta` write **`{record}` (the reference), not `{record.<field>}`**: the two
counts are taken either side of the steps, so a field literal is rendered from two different values
and their difference means nothing — assert a field with a `record:` expectation instead.

⚠ **`given.where` may NOT use `{record}`** — compile refuses it (`given.where cannot use {record} —
the given is what PICKS the record`). The substitution is an EXPECTATION's, and for a reason that is
not a rule but arithmetic: the given is what selects the record, so at the moment its filter runs
there is nothing bound yet. The literal used to compile and the proof then answered NO-FIXTURE
forever, which reads as a fact about the workspace's data. For the same reason, a `{record}` literal
in an expectation's `where` on a proof with **no `given` at all** is refused too (`an expectation
uses {record} but this proof declares no given`).

⚠ **`record:` is not a template — it is always the literal `{record}`**, and compile refuses any
other value (`a record expectation targets {record} — the picked record is its only target`). The
`given` picks one record and there is no second one to target, so `record: notes/b` was a proof
judged against a different record than the one it names.

**The four expectation forms.**

| form | asserts |
|---|---|
| `{ collection, where, count }` | how many records of `collection` match `where`, collection-scope |
| `{ record: '{record}', where }` | the picked record's own fields. Needs a `given`; an empty `where` is refused |
| `{ step: <n>, exit, stdout, stdout_json }` | what one `run` step did. `step` defaults to the LAST run step; an index past the last step is refused |
| `{ path: '<template>', exists: true\|false }` | whether a path is there, rendered through the ONE resolver, **relative to the workspace root** (the sandbox's root inside a `writes` proof) |

⚠ **A row is exactly ONE form, and a row whose keys span two is a compile error** —
`expect[<i>] mixes two forms — a row is one of collection+where+count · record+where · step ·
path+exists`. It is refused rather than resolved because compile and the judge would otherwise read
the same row as different shapes, and a row judged as the wrong form produces **zero verdict lines**
— which passes, vacuously. Measured: `{ record: '{record}', path: 'nope.txt', exists: true }`
compiled as a path row, was judged as a record row, and answered exit 0 `PASS` on a file that has
never existed. `{ record, where, count }` was the same seam upside down — the count's operators and
integers were validated line by line and then never read.

**`count`** takes its own closed operator set — `_eq _neq _gt _gte _lt _lte _delta` — and every
operand must be an INTEGER: `_gte: 'one'` and `_eq: 1.5` are filters that can never be satisfied, and
compile says so as `count "<op>" compares "<v>", which is not an integer`. A bare scalar is the
`_eq` it stands for. `count: {}` is refused: it compares nothing and so holds for every possible
count.

**`_delta` is after − before**, judged against the snapshot taken before the first step ran and
carried on the PENDING row. It is the honest way to say "one more note exists" in a collection that
already has records — `count: { _gte: 1 }` there is true before anything happens. ⚠ A missing
snapshot is a **FAIL** naming the repair (`no before-count in the pending row — re-run dt prove <id>
--restart`), never a delta measured from zero: fail-open there turned "one more" into "at least one"
and passed on a collection nothing had touched.

**`stdout` and `stdout_json`.** A step's stdout is captured up to **64 KB** and judged WHOLE, not as
a tail. `stdout` takes filter operators over the text (`{ _contains: 'wrote 3 rows' }`);
`stdout_json` parses the full capture and takes a dotted path per condition
(`{ 'summary.rows': { _gte: 1 } }`). A payload that is not JSON is its own verdict —
`stdout is not JSON (…) ✖` — rather than a pile of `undefined` comparisons. Output larger than
64 KB belongs in a file the proof asserts with `path:`.

**Every verdict line prints the ACTUAL value beside the wanted one**, always:

```
  count +1 = +1 ✔
  status "open" ∈ [done] ✖
  exit 0 = 0 ✔
```

## the protocol — run it, do what it says, run it again

Most live proofs about a command or a skill cannot be run by a machine end to end: the middle step
is an actor. So the runner stops there, records a PENDING row, and prints the block:

```
in       /repo/.worktrees/.tmp-a1b2c3   (a throwaway worktree — records written here are never landed)
PERFORM  /close-note notes/b
source   modules/default/commands/close-note.command.md
then     dt prove notes-close-cleanly --record notes/b   (the same verb, again)
```

- **`in`** appears only when there IS a sandbox, and it comes FIRST — "where am I acting" has to be
  read before "what do I do", or a human writes real records the proof will never judge.
- **`PERFORM`** is the instruction, substituted. Take it.
- **`source`** is the command's SOURCE file, off the manifest, when the text opens with `/<command-id>` —
  so the actor can open the thing they are being asked to run.
- **`then`** is the exact line to type next. The same verb, again: `--record` names the pending run
  this invocation is FINISHING, and nothing else.

The re-run judges — it does not re-run the steps. The record, the step results and the `_delta`
snapshot all come off the pending row, because those are the facts of the run being finished.

**A live pending run blocks a fresh one.** Any of them: the refusal names the record to finish
with, and when several records are pending it lists them all rather than sending you round the loop
once per row. (The one case that resumes itself is a proof with no `given` — it pends against no
record, so `--record` cannot name it and the bare verb is the only way back.)

**`--restart`** discards every live pending run and starts over: the discarded rows are recorded as
discarded and their sandboxes removed. ⚠ A discarded row is written as a **FAIL**, so until the
restarted run reaches a verdict this proof's ledger tail is a FAIL — `dt status --strict` is red in
between, which is correct (nothing has passed since) and worth knowing before you wire it into a
hook.

A pending run older than the proof's own `timeout` is **stale** — the process it belonged to is gone
— so it is cleared out loud on the next run.

## the sandbox — where a `writes` proof is allowed to write

`mode: writes` mutates records, so it never touches the invoking store. The runner cuts a detached
throwaway worktree (`.worktrees/.tmp-*`), copies the proof's fixture into it, runs there, judges
there, and removes it.

- **A sandbox is cut from HEAD.** Uncommitted sources are ABSENT from it — the engine-ships-first
  rule in miniature. A collection whose descriptor is not committed is not compiled inside the
  sandbox, its records are invisible rather than invalid, and every count would read zero. So the
  runner refuses first, naming it: `collection "ghosts" is not compiled in the sandbox — commit its
  descriptor, because a sandbox is cut from HEAD`.
- **A fixture may contain only `data/`.** It mirrors the workspace ROOT, so anything else would
  overwrite what the checkout carries — including the very descriptors its records are then
  validated against. Dot-entries are ignored (your file manager writes `.DS_Store` there and it comes
  back), and `data` must be a directory.
- **The fixture is the one input nothing validated on the way in**, so the engine's own `check` runs
  against the sandbox before any step does; the first violation is what the failure names.
- **`--keep`** leaves the sandbox in place after a verdict, to look at. It is only meaningful for a
  sandboxed proof, and `dt status` counts what runs left behind — `.worktrees/` is gitignored, so
  the ledger is the only thing that knows the directory exists. A removal that FAILED is recorded as
  `sandbox_removed: false` and counted the same way.
- **`--here` runs a `writes` proof in THIS checkout**, and says so out loud before anything moves. It
  is legitimate for exactly one shape: a `given.where` writes proof, against a real record, when the
  point is to prove the thing on live data. A `writes` proof with no fixture runs ONLY that way —
  otherwise it is refused at run time, naming both ways forward.

## the ledger — per machine, per proof, and disposable

`.dreamteamer/.proofs/<proof-id>.jsonl` — one JSON row per run, oldest first, appended, **capped at
the last 50**. It answers "when did this last pass, on this machine, and against which record", and
it is what makes a `perform` step resumable.

⚠ **The dot is load-bearing.** `.dreamteamer/proofs/` is the compiled KIND folder and compile wipes
every kind folder on every run, so a ledger written there would be destroyed silently. The
dot-prefixed sibling is invisible to that loop and to every source enumeration, and it is already
gitignored.

**It is evidence, not data.** `rm -rf .dreamteamer && dt compile` — the folk recovery for a stale
runtime — takes the ledger with it, and the cost is **re-proving, not data loss**: what a proof
asserts lives in the committed source, and the rows were only ever about this machine. A malformed
line (a killed run, a hand edit) is skipped with a warning and repaired by the next append.

## exit codes

The point of the verb: a script branches on the number.

| code | state | means |
|---|---|---|
| `0` | PASS | every expectation held |
| `1` | FAIL | a step failed, or an expectation did not hold |
| `2` | usage | RESERVED, and not reachable from a proof — it is what a RETIRED verb spelling answers. A bad flag or an unknown target inside `dt prove` is an ordinary error at `1` |
| `3` | UNAVAILABLE | this machine lacks a required var or binary — **not** a failure of the artifact |
| `4` | NO-FIXTURE | the `given` matched no record, or the fixture folder holds none |
| `5` | PENDING | a `perform` step is owed a human or an agent |
| `6` | VACUOUS | every expectation ALREADY held before any step ran |

**VACUOUS is the most valuable state in the set.** A proof whose expectations already hold reports
PASS forever and measures nothing — the silent green this whole verb exists to remove. It is checked
BEFORE any step runs, so it is caught before the proof takes an action. `step` and `path`
expectations are not pre-checkable and never make a proof vacuous.

⚠ **`dt prove <artifact>` with NO proof about it is VACUOUS too** (exit 6,
`no proof is about <ref> — dt list proofs --missing`). It used to answer `proofs: 0 passed · …` at
exit 0 — and the orientation block tells every session to quote this command before saying an
artifact works, so a green result from a question nobody had asked was rule 7's own failure mode
shipped as a feature. `--all` over a workspace with no proofs keeps its exit 0: "run everything" is
truthfully green at zero; "prove THIS artifact" is not.

**UNAVAILABLE is checked before the fixture**, so a machine that cannot answer never reports
NO-FIXTURE — which would read as a fact about the workspace's data rather than about this laptop.
A `writes` proof with no fixture is UNAVAILABLE too: the artifact is fine, and this invocation
cannot answer for it without `--here`.

⚠ **`--strict` means two different things, on purpose.** On `dt prove --all` (and the artifact form)
it makes **UNAVAILABLE fatal** — a board is what a hook runs, and "this machine could not ask" is a
gap the hook may want to fail on. On `dt status` it fails on a **FAIL tail** in the ledger and says
nothing about UNAVAILABLE, because that line reports what this machine has already proved rather
than running anything.

## reading the surface

```bash
dt prove <proof>                 # one proof: the transcript, and one of six codes
dt prove skills/<id>             # every proof whose `about` names this artifact — a board;
                                 #   exit 6 when NOTHING is about it
dt prove --all [--kind gate|live] [--external] [--strict] [--json]
dt list proofs [--missing] [--filter …] [--json]
dt get proofs/<id>               # the record, plus availability and the ledger tail
dt get commands/<id>             # the artifact, plus the proofs that are about it
dt status [--strict]
```

- **`--all` and the artifact form are BOARDS: ONE line per proof**, then a summary
  (`proofs: 3 passed · 1 failed · 0 unavailable · …`). A transcript is what a single-proof run is
  for. A proof with a `perform` step is **listed, never started**, so a board can never exit 5 —
  "one of your forty proofs would like a human" is not an answer a hook can act on. A proof that
  THROWS is that proof's FAIL, with a ledger row, not a silently green skip. The `writes` proof with
  no fixture is not an exception to that: it SETTLES `UNAVAILABLE` with a row, in the single-proof
  form and on the board alike (and `--strict` is what makes it fatal).
- **`--strict`** makes UNAVAILABLE fatal on a board. It is a flag rather than the default because a
  proof needing a credential is ordinarily unavailable on a cloud session.
- **`dt list proofs`** appends two COMPUTED columns no record carries: `availability` on THIS machine
  (with the fix, never a `.env` value) and `last`, the ledger tail (`PASS 2026-09-07 [notes/b]`, or
  `never`). **`--missing`** inverts it — one line per artifact no proof is about — and takes no
  filter, because it lists artifacts rather than proofs.
- **`dt compile` prints a coverage line on EVERY compile**, even at zero:
  `proofs: 4 declared · commands 1/2 · skills 0/1 · scripts 1/1 · bindings 0/0`. And it **nudges
  once** per NEW command or script with no proof, naming the file to write. `--missing` is the same
  question answered by name.
- **`dt status`** counts each proof's LAST verdict on this machine
  (`proofs: 7 declared · 1 passed · 1 failed · 1 unavailable · 4 never`) and `--strict` exits 1 when
  any tail is a FAIL.

## the eval layer — proving a skill actually TEACHES

A skill's proof can assert that its file compiles, that the script it names runs, that the record it
promises appears. None of that answers the question a skill exists for: does a fresh session FIND
it, LOAD it and DO the job right. That is answered by running sessions and scoring them. **The
engine never runs an agent** — this is a procedure, and the record of it belongs wherever the
workspace keeps its findings, not in a `proofs` record.

The method, as run on 2026-09-05 against a rebuilt orientation block:

1. **Pick five REAL tasks** out of this workspace's own history — things that were actually done,
   across different modules and different grains. Invented tasks measure how well you invent.
2. **Give each session ONLY the artifact under test** plus whatever the harness injects anyway. No
   briefing, no hints, no follow-up steering. Five separate blind sessions, one task each.
3. **Have each session plan the task**, then **verify its own plan against the records and skills
   that actually did the work**, then **review the packet adversarially** — what misled it, what it
   could not find, what it invented.
4. **Score each session on the sheet below**, and read the failures for their SHAPE rather than
   one at a time. Five sessions failing at five different points is noise; five failing at the same
   depth is the finding.
5. **Repair, then rescore.** A repair nobody re-measured is a hypothesis.

| dimension | 1 | 3 | 5 |
|---|---|---|---|
| **found it** | never opened the artifact | opened it after guessing wrong first | loaded it before acting |
| **routed the noun** | wrote to the wrong collection | right collection, wrong grain | right collection, right grain |
| **respected the refusals** | proposed a write the store would reject | hit one refusal, recovered | wrote nothing that would be refused |
| **followed the order** | ignored a stated ordering constraint | followed it after being wrong once | followed it first time |
| **joined correctly** | missed a join the data requires | found it by reading records | found it from the artifact's own prose |
| **invented nothing** | invented a field, a status or a path | invented one, caught it | cited every value it used |

Two findings worth carrying, because they generalize: a `use_when` clause earns its tokens exactly
where it encodes an **order** or a **refusal**, and loses them where it paraphrases the description;
and every session failed at the same depth — a JOIN, an EXECUTABLE nothing rendered, or a REFUSABLE
WRITE (a closed enum, a required field) the prose never showed.

## common mistakes

| mistake | reality |
|---|---|
| a `count: { _gte: 1 }` on a collection that already has records | it holds before the step runs — that is VACUOUS, and `_delta` is what you meant |
| `about:` naming a skill that does not exist | compile fails: a proof about nothing reports success forever |
| a nested key meant as a field comparison | it is a reference HOP; compile refuses it by name |
| `record: notes/b`, or any target but `{record}` | the `given` picks the record; compile refuses a second target |
| expecting a `{record}` in a `run:` step to reach the shell as a reference | it does — that one IS substituted; it is every OTHER brace that passes through untouched |
| `where:` left bare, or `where: {}` | it asserts nothing and the proof passes having measured nothing — refused at compile |
| judging a `writes` proof by running it with `--here` on real records | that is what a fixture and a sandbox are for; `--here` is the exception, not the default |
| expecting `--all` to run the `perform` proofs | it lists them; a board is for a hook, and a hook cannot perform |
| reading a step's stdout as a tail | it is captured and judged WHOLE, to 64 KB — over that, write a file and assert `path:` |
| committing the ledger | it is per-machine evidence under gitignored build output; the SOURCE is what travels |
| a fixture carrying a `package.json` or a descriptor | only `data/` is admitted — otherwise a proof can bring the rules it is judged by |
| a proof whose descriptor is not committed | a sandbox is cut from HEAD; commit the schema before the proof that needs it |
| treating UNAVAILABLE as a failure | this machine cannot answer the question — the artifact is not implicated |
| a `kind: eval` proof | there is no such kind; the eval layer is a procedure, and the engine never runs an agent |
| one `expect` row carrying two forms' keys | refused at compile — a row judged as the wrong form asserts nothing and passes |
| `{record}` in `given.where` | nothing substitutes there; the given is what picks the record |
| a relative `path:` read as "beside where I typed dt" | it is resolved against the WORKSPACE root — the sandbox's, inside a `writes` proof |
| `dt prove skills/x` exiting 0 as proof that the skill works | exit 6 when nothing is `about` it; check the code, not the absence of red |
