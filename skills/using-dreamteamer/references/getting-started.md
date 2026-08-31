# getting started — from nothing, or from a pile, to a working workspace

Three arrivals land here, and they end in the same place. **The empty folder**: someone ran
`npm install dreamteamer` (or is about to) and has nothing else. **The existing pile**: a repo or
folder that already holds real files — notes, exports, spreadsheets — that should become records.
**The operator who is technical enough to run npm and not much more** — for whom the git section
below is written in plain words. The finish line for all three is identical: a compiled runtime,
ONE honest collection with real records in it, published — not an architecture.

No UI is assumed anywhere below. The CLI and the records are complete on their own; any surface
that reads the compiled runtime can render the same workspace later, unchanged.

| the situation | read |
|---|---|
| nothing exists yet | the skeleton, then path A |
| real files already exist | the skeleton, then path B |
| dreamteamer joins a repo that also holds code | the skeleton, then path C |
| "do I need git? a server? an account?" | git, in plain words |

## the skeleton — five commands, one minute

```bash
npm init -y                 # only if there is no package.json yet
npm install dreamteamer
git init                    # strongly recommended, not required to start — see below. first,
                            # so init can commit its own skeleton (it does, when git is there)
npx dreamteamer init        # writes the workspace skeleton; never compiles
npx dreamteamer compile     # materializes the runtime; writes the orientation block
npx dreamteamer check       # should report 0 violations over the starter collection
```

`init` writes the `dreamteamer` block into `package.json` (the workspace manifest —
`collections.md`), a workspace module at `modules/default/` with a starter `notes` collection,
and `.env.example`. `compile` is what makes it real: the runtime under `.dreamteamer/`, the
harness folders, and the orientation block every future agent session reads — which is how the
next session finds this skill without being told.

## git, in plain words

git is three things to this workspace, and none of them needs a server or an account:

- **the history** — every change to every record, forever, answerable (`dt history`, `dt changes`);
- **the undo** — any record restorable to any prior state (`records.md`, undoing);
- **the publish step** — `dt commit` is what turns "written to disk" into "on the record".

Verified capability split: **without git, everything still reads, writes, validates and compiles**
— only `dt commit`, `dt changes` and `dt history`/`diff`/`revert` are unavailable. `git init` is
one command, local, free, and turns all of them on. A **remote** (GitHub or anywhere) is a
separate, optional, later decision — it buys backup and a second machine, and nothing here needs
it. If the operator is unsure: run `git init`, skip the remote, move on.

## path A — nothing yet: model from an interview

The first hour's goal is **one collection the operator will actually touch tomorrow**, holding
real records. Not five collections, not a namespace plan, not a module layout.

1. **Find the daily thing.** Ask what they keep re-finding, re-asking or losing — the answer names
   the first collection. When the requirement is vague, `data-modeling.md` Part II is the
   interview: twelve questions, most answered by the requirement itself.
2. **Propose small, then stop.** The proposal contract (`data-modeling.md` §7): the descriptor
   YAML, one sample record as its `dt add` line, and what is deliberately NOT modelled. The
   operator says yes before anything lands.
3. **Create it in the workspace module** — `dt schema add-collection` (it compiles and publishes
   itself). The workspace module is the right first home for everything (`data-modeling.md` §8);
   extraction is a decision for the second consumer, months away.
4. **Seed three to five REAL records immediately** with `dt add` — not test data. Seeding real
   records before declaring the model finished catches half the field mistakes: the missing unit,
   the enum the domain spells differently, the id that comes out wrong.
5. **Iterate on evidence**: `dt values` shows what the fields actually hold, `dt check` what
   disagrees. Adjust, then — only then — consider the second collection.

Deliberately deferred, each until its trigger: a **namespace** (first second-DOMAIN collection,
not before — `collections.md`) · a **module of its own** (a second consumer or a closed reference
graph — `data-modeling.md` §8) · **skills, commands, views** (after records exist — behaviour
follows shape, and a view needs a recurring question to encode).

## path B — dreamteamer over an existing pile

The pile is evidence; read it before modeling anything.

1. **Survey**: what file kinds, how many, what dates and names they carry, and — most useful —
   what questions the operator actually asks of this pile. Read a handful of files end to end.
2. **Split the pile in two.** Files that already look like records — one thing per file, with
   discoverable fields — get **registered where they stand**: `collections.md`, "registering an
   existing data folder" (derive the descriptor from reality; an authored `storage.path` points at
   the existing folder; **never rewrite records to fit an inferred schema**). Tabular exports
   (CSVs, spreadsheets) get **imported**: `records.md`, the bulk-write recipe — one script, one
   check, one collection-scoped commit.
3. **Big and binary files never become records.** They stay where they are (or move to a files
   folder), and a record points at each via a `${env:VAR}` template — the filing convention and
   the mechanics are in `records.md`.
4. **Restructure later, with the tools that keep references true** — `dt rename`,
   `dt schema rename-collection` — not during the first pass. Model reality first; `check` will
   tell you what reality violates, and that list, not taste, drives the cleanup.

## path C — into a repo that already holds code

The workspace root is wherever `package.json` carries the `dreamteamer` block — a repo can be
both a codebase and a workspace. `init`'s runtime folders are gitignored, records default to
`data/` beside the code, and an authored `storage.path` can put any collection anywhere the repo
prefers. Nothing about the code moves; `check` and `compile` read only what descriptors name.

## the first hour's mistakes

| mistake | reality |
|---|---|
| modeling the whole domain up front | one collection used tomorrow beats five perfect ones — widening is always safe later (`data-modeling.md` Part IX) |
| test data in the seed records | real records are what catch the model's mistakes |
| skipping git as "too technical" | one local command, no account — and it is the history, the undo and the publish step |
| inventing ids by hand | `id.generate` owns identity — pass `--id` only when the operator named one |
| hand-writing the first descriptor | `dt schema add-collection` is compile-gated and publishes itself; hand-written sources owe `dt compile` |
| rewriting existing files to fit a guessed schema | describe reality, compile, `check` — then decide which violations are worth fixing in the data |
| waiting for a UI before starting | the CLI and the records are the complete system; any surface renders them later, unchanged |
