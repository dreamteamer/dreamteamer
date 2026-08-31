# working with records — read, write, publish

**core principle:** the CLI is the default path — it validates before disk, generates the id,
materializes defaults, and its writes are pathspec-scoped so they can never sweep a stranger's
work. direct file edits stay first-class, but then *you* owe every rule below.

## when to use

any time a record is read, created, changed, renamed or removed — anything under `data/`. load it
especially when you catch yourself about to `mv` a record file, hand-write frontmatter from
memory, or set a field you haven't read in the descriptor.

**not for:** schema changes (`collections.md`) — and system-stored records (skills, agents,
commands, ui-views, collections) are *sources*: edit the file under the owning module and
`dt compile`; the CLI refuses them on purpose.

## reading and measuring

the verbs and flags are `dt help`'s job; what to know *about* them:

- narrowing a `list`: `--filter k=v` for one condition; **anything compound goes in one
  `--where`** — its operator grammar is enumerated in `dt help`, and it is
  the same one views and gates use — e.g.
  `dt list health/prescriptions --where '{"_and":[{"patient":{"_eq":"health/patients/dana-levi"}},{"status":{"_eq":"active"}}]}'`.
  ⚠ two `--filter` flags do NOT combine (the last one wins), and an unknown field or a dangling
  ref **narrows to nothing** rather than erroring — filter field names deserve the same care as
  code.
- ⚠ **there is no `@me` and no `users` collection** (both removed in 0.8.0). when a person is
  needed, read `git config user.name`; filter on a person only when this workspace ships its own
  collection of people.
- `dt values <collection> <field>` is a field's *actual* vocabulary — what a proposal, a filter
  or a validator should offer as choices.
- `--json` works on every record and reporting verb (`resolve` excepted) — use it whenever
  output will be parsed.
- `dt history` / `diff` / `revert` are the record-grain view of git — reach for them before
  hand-rolling `git log` on a record path.

## writing through the CLI

- **validation is hard and includes unknown fields.** a typo'd key (`--assinee`), a dangling ref,
  a bad enum value (the error echoes what it got), an id missing `id.pattern` — rejected with
  nothing written. a rejected write leaves no partial state.
- **a write puts the record on disk; `dt commit` publishes it** — committing is workspace policy
  (`auto-commit` in `package.json`, default off), never part of the write.
- `set <collection>/<id> <field>=` with an empty value **removes** the field; array fields take a
  comma-separated value; the `x-body` field is set like any other field.
- ids generate from the record's own creation-time values — pass `--id` only when the operator
  named one.

## before writing anything

read the compiled descriptor: `.dreamteamer/collections/<collection>.collection.yaml`. it defines
`storage` (path/codec/shape/suffix), `id` (`generate` template + `pattern`), and `schema` (JSON
Schema; the `x-` keywords carry the domain semantics — `x-reference`, `x-body`, `x-inverse`). it
also carries `title` (what to call the collection) and `title_template` (how to label one record).

the schema is the CONTRACT, and it is required to be sufficient: each field's `description`
carries its conventions, an `examples:` annotation (standard JSON Schema — compile passes it
through to the compiled descriptor) carries a canonical value where the shape is non-obvious, and
`dt values` shows a vocabulary's real spread. a schema that makes you peek at data to write
correctly is a defect in the schema.

## writing a record by hand

**default to `dt add <collection>`** — id, defaults and validation in one line. hand-write only
when the CLI can't express the value: a nested map, or a long structured body.

when you do, the descriptor is still the contract — required, defaults, each field's
`description` and `examples:`, `dt values` for vocabularies. peek at a sibling
(`dt get <collection>/<id> --json`) only when the schema underdocuments a convention you need — a
sibling is ONE arbitrary instance, possibly written before the schema last moved — and the miss
itself is the finding: put the convention into the field's `description` (or an `examples:`) in
the same breath, so the next writer needs no peek. then:

- put the file where the id says: the id IS its path inside `storage.path`, minus suffix and
  extension (folder-shape records are a folder named `<id>` holding the descriptor's `entry`).
  the id template is evaluated ONCE, at creation, and never re-derived — a later edit to a field
  it named does not move the record — and the result must satisfy `id.pattern`.
- **materialize defaults explicitly** — write `status: todo` even though it's the schema default;
  a file should be legible without its schema.
- `dt check` is the only validation a hand-write gets. run it before you commit.

example — `data/tasks/2026-07-25--fix-login-flow.task.md` (`md` codec: frontmatter holds the
fields, the body is the single `x-body: true` field):

```markdown
---
title: Fix login flow
status: todo
assignee: contacts/ada
due: '2026-07-28'
---
Users report the login button does nothing on mobile.
```

## namespaced collections

a collection may be scoped under a namespace declared in the workspace `package.json`
(`dreamteamer.namespaces`). working with its records is unchanged except that the QUALIFIED name
is the collection's name everywhere: `health/doctors/dana-levi` is the collection `health/doctors`
and the id `dana-levi` — a reference splits at the end of the **declared** prefix, never at the
first slash. the default namespace has no prefix (`tasks/kickoff`, exactly as always), and an
undeclared prefix reads as a nested id and dangles — `dt check` says so. declaring one is
`collections.md`.

## two-way relations — the mirror is generated, and read-only

a reference field may declare `x-inverse`: compile GENERATES the field it names on the TARGET
collection, and the store maintains that value in the same write as every change to the owning
side. so **never set or hand-edit a mirror** — `dt set` refuses it, and a hand-edit is what
`check` reports as `<field>: stale`; write the owning side's reference and the mirror follows.
`dt relations` lists every pair (owner.field → target.mirror, cardinality, on-delete) and
`dt relations rebuild <collection>` recomputes mirror values from the owning side — the repair
that message names, and the only thing that writes a mirror directly.

## machine-specific paths — templates

a path that exists on only one machine — a synced folder, an external disk — is written as a
**template**, never as an absolute path:

```yaml
source_file: ${env:FILES_FOLDER}/2026/q3.pdf
```

- `${env:NAME}` renders to `NAME`'s value in the workspace's `.env` — and only if `NAME` is
  listed in `dreamteamer.vars` in `package.json` AND non-empty there. an undeclared key and a
  declared-but-absent one are deliberately different errors: the first is a typo, the second is a
  machine nobody set up. `${workspaceFolder}` and `${userHome}` also resolve.
- **`dt resolve` is the only substitution point** — `dt resolve '<string>'`, or
  `dt resolve <collection>/<id> <field>` for what a record holds (array fields print one item per
  line). an argument containing `${` is always a template, so a ref-shaped one is never split as
  a reference.
- **an attached FILE follows the filing convention**: a files folder is named after the
  collection or field that indexes it, and the path below it is the record id —
  `${env:FILES_FOLDER}/visit-recordings/<record id>.m4a` needs no lookup table. a collection
  whose records ARE files (`codec: file` — icons, images) is written with
  `dt add <collection> --from <path>`, never with field flags: the fields derive from the file.
- ⚠ **templates are ordinary data — write them literally.** `get`, `list`, `check` and every
  harness read the template verbatim; nothing substitutes until resolve is called.

## committing — publishing what you wrote

- **commit when a logical change is complete.** an uncommitted write is invisible to `dt changes` and to every
  other CLONE — while a session SHARING this tree sees it immediately, which is why the sweep
  rules below exist — `auto-commit` off makes the commit a deliberate act, not a
  forbidden one, and publishing what the operator asked you to write needs scope, not permission.
  `dt status` says what is pending.
- **records are `dt commit`'s to publish; sources are git's.** a module source change (a
  descriptor, a command, a skill) is staged with `git add <the specific files>` and committed —
  `dt commit` targets collections and records only.
- **scope to what YOU wrote**: `dt commit <collection>/<id>` — any number of targets, each a
  whole `<collection>` or one record. bare `dt commit` publishes *everything* pending, and
  `dt commit <collection>` publishes every dirty record under it *whoever wrote it* — the same
  sweep as a blanket `git add` when a second session shares the tree. `--dry-run` shows the set
  first; read the record list a commit always prints.
- **a bulk write is ONE logical change.** an import loop or a one-shot script leaves dozens of
  records pending; naming each is absurd and per-record commits shred the change's audit trail.
  the honest sequence: write them all → `dt check` → `dt commit <collection> --dry-run` to
  confirm nothing a DIFFERENT session has pending sits in the set (`dt status` gives only counts) → then the collection-scoped commit is
  the right tool, not a hazard — the sweep warning above is about sharing a tree, not about batch
  size.
- **a relational write dirties two records** — the owner and its mirror partner. a RECORD-scoped
  commit sweeps the target-side partners *your* write dirtied, and REFUSES when the far side's
  own owner is dirty from someone else: scope to the pair rather than publish half of anyone's
  work. the COLLECTION form publishes exactly what it names and prints the partners it left
  pending — HEAD then fails `dt check` until they land.
- **one commit per REPO.** a module can own its records (`owns-data` in its package.json), and
  git has no cross-repo commit — a rename whose inbound refs live in another repo is TWO commits;
  `dt commit` prints both.
- when git is used directly (hand-edited markdown bodies), stage the specific files — never
  `git add -A`, `git add .`, or `git commit -a` in a tree other sessions may share.

## undoing

- an UNCOMMITTED write: `dt commit --dry-run` names the pending records (`dt status` gives only
  COUNTS; `git status` the files) — restore the files with `git checkout -- <paths>`, both halves
  of a relational write together (or the mirror goes stale); `dt check` confirms.
- a COMMITTED change: `dt revert <collection>/<id> --hash <sha>` restores that revision on disk
  as a PENDING write — `dt commit` publishes it; history is never rewritten. `dt history` lists the revisions, `dt diff` shows what one
  applied.
- a rename: `dt rename` back — inbound references are rewritten again, symmetrically.
- a DELETED record: its id is gone, so the record verbs can no longer see it — restore the file
  with git (`git log -- <path>`, then `git checkout <sha> -- <path>`) and run `dt check`.
- a schema verb: it committed its own source write — revert that commit with git, then
  `dt compile`.

## the hard rules

**never hand-rename or `mv` a record file** — the id IS the path, so a rename silently dangles
every inbound reference; `dt rename` moves the file and rewrites
every inbound ref in the same WRITE — `dt commit` then publishes the whole rename together (the
entanglement guard prints the set to name). **never
delete a referenced record** — `rm` refuses while anything points at it, unless that field
declares `x-on-delete: set-null`, which clears it instead; retarget first. **a changed title
never changes the id.** **one logical change, one commit** — a bulk import is ONE change, not
two hundred.

## common mistakes

| mistake | reality |
|---|---|
| `mv data/tasks/old.task.md …/new.task.md` | every inbound ref now dangles. `dt rename`. |
| renaming a record because its title changed | the id is not a display name — edit the field |
| two `--filter` flags to AND conditions | the last flag wins — compound conditions go in one `--where` |
| `--force` to get past an `rm` refusal | it leaves inbound refs dangling — retarget them first (unless the refusal named a *prose* mention, which isn't a real reference) |
| omitting schema defaults from a hand-written file | the file stops being legible without the schema |
| unquoted `due: 2026-07-28` in hand-written YAML | dreamteamer parses CORE_SCHEMA so it stays a string *here*, but a default-schema YAML reader turns it into a timestamp — quote dates |
| setting a generated mirror | refused by `set`; a hand-edit goes stale — write the owning side |
| CLI-editing a skill / agent / command / collection | system sources — edit the module file, then `dt compile` |
| resolving a template by hand | `dt resolve` is the only substitution point |

## red flags — stop

- you're about to `mv`, `cp` or `rm` a file under `data/` directly
- you're writing a reference you haven't confirmed resolves
- you're editing anything under `.dreamteamer/` (generated, gitignored)
- you finished a bulk edit and haven't run `dt check`
