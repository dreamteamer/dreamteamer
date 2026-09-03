---
name: using-dreamteamer
description: always load first in a dreamteamer workspace — reading, writing and committing records, and changing what the workspace keeps or does (collections and fields, skills, commands, agents, ui-views, component code). Also when deciding which of those a request should become, when a compile or check error names a source file, or when a request names a new kind of thing to keep. Also for a brand-new or just-installed workspace, or dreamteamer over existing data.
---

# using dreamteamer

this is a **dreamteamer** workspace: collections of typed records, plus the skills, commands,
agents and views that operate on them — all compiled from sources into a runtime the harness
reads.

**core principle:** read the compiled runtime, write records with the CLI and sources under
`modules/`, compile after any source change — then `dt commit` publishes what you wrote.

## when to load

first thing, every session in this repo. reload mid-session on any of these symptoms: you're
about to guess a collection's fields; you can't tell whether the file to edit lives under
`modules/*/<kind>/` or `.dreamteamer/`; you wrote something and the harness didn't notice; you're
unsure which skill owns the job in front of you.

## the contract

| concern | where | rule |
|---|---|---|
| schemas (read) | `.dreamteamer/collections/*.collection.yaml` | the single source of truth for what exists and its shape. **never edit under `.dreamteamer/`** — generated and gitignored |
| provenance | `.dreamteamer/manifest.yaml` | which module shipped which entry |
| sources (write) | `modules/<module>/<kind>/` — **including the workspace's own**, the `dreamteamer.workspace-module` named in `package.json` | a source folder at the workspace ROOT is a compile error (whenever `workspace-module` is set — every `dt init` workspace); same-name collisions across modules too. after ANY source change: `dt compile` |
| records (write) | `data/…`, per each descriptor's `storage.path` | the CLI writes them validated; hand-edits are legal and owe `dt check` |

- a record is a `<id>.<suffix>.<ext>` file (or a folder, for folder-shape collections). **the id
  is the path** inside the collection folder minus suffix and extension — nested folders join in:
  `data/meetings/2026/07/standup.meeting.md` ⇒ id `2026/07/standup`.
- **references are `<collection>/<id>`** strings — always qualified, greppable, never a bare name
  and never a file path.

**lifecycle:** `dt init` writes a new workspace's skeleton (it never compiles). a FRESH CLONE owes
`dt install` (restores `git_modules/`) then `dt compile` before anything reads — `.dreamteamer/`
and the harness folders are gitignored build output, so a clone has no runtime until compile
writes one — and `.env` is per-machine (declared keys: `references/records.md`). `dt status` says
whether the runtime is fresh. the workspace's own switches live in `package.json`'s `dreamteamer`
block (`references/collections.md`, the workspace manifest) — and the guided path from nothing,
or from existing data, is `references/getting-started.md`.

## the CLI is the front door

`dt` in this skill means the dreamteamer CLI: **`npx dreamteamer`** works in any workspace, and a
workspace may alias it as an npm script — check `scripts` in `package.json` (the common spelling
is `npm run --silent dt -- <verb> …`).

**default to the CLI for every record read and write.** it validates before disk, generates the
id, materializes defaults, and its writes are pathspec-scoped; touch a record file by hand only
when the CLI cannot express the change (a long body, a nested map) — and then you owe `dt check`
(`references/records.md`).

**`dt help` is the complete command surface** — record verbs, system verbs, field verbs, workspace verbs, and
their flags, on one page (there is no per-verb `--help`).

the verb names, as a map (semantics and flags live in `help`; a test holds this list to the
dispatch, so it cannot drift):

- read & measure — `list` `get` `values` `history` `diff` `commands` `relations` `resolve`
- write & publish — `add` `set` `rm` `rename` `move` `revert` `commit` `ensure`
- fields (sources, through the compile gate) — `add-field` `update-field` `remove-field` `rename-field` (system entities — modules, collections, skills, ui-views… — take the RECORD verbs above)
- workspace — `init` `install` `update` `compile` `check` `status` `start` `changes` `help` don't learn syntax from prose, this skill included: prose drifts, and `help` ships in
the same file as the dispatch it documents. run it once before your first write of a session.
what prose adds is judgment — *when* a verb is the right move, and the guarantees you can lean
on: **validation is hard** (unknown fields included; an invalid write is rejected before disk
with no partial state), and **a write does not commit** — `dt commit` publishes, scoped
(`references/records.md`).

## two acts, one map

Act one is **working with data** — the records themselves. Act two is **modeling the workspace**
— changing what it keeps (collections, fields) or what it does (skills, commands, agents, views).
Load by the map; nothing here is loaded "just in case".

| the job | load |
|---|---|
| a brand-new or empty workspace, dreamteamer over an existing pile of files, "help me set this up" | `references/getting-started.md` |
| read, create, update, rename, delete, commit — or UNDO — a record | `references/records.md` |
| "what changed while I was away" | `references/changes.md` |
| the workspace seems unable to do something — a new kind of thing, a missing capability, "don't we already have this?" | `references/before-you-build.md` (look first); a new model then continues `references/data-modeling.md` (decide) → `references/collections.md` (write it) |
| a collection or field, mechanically — the descriptor, the system and field verbs, `templates:`/`extends:`, a compile or check message | `references/collections.md` |
| knowledge a session should find on its own | `references/skills.md` |
| "let me type one word and have this done" | `references/commands.md` |
| "which command applies to this record?" — a binding, a gate | `references/commands.md` |
| a job needing a fresh context and its own tools | `references/agents.md` |
| a route, a nav entry, a board / calendar / map over records | `references/ui-views.md` |
| a rendering or editing behaviour nothing registered has | `references/ui-components.md` |

three act-two tie-breakers, because they are the ones that go wrong:

- **skill vs command:** a skill triggers itself when the situation arises; a command needs the
  operator to remember it exists. if the answer is "and they'd have to think of running it",
  write the skill.
- **agent vs skill:** an agent costs a whole context. if "just tell the current session how"
  works, it is a skill.
- **a multi-step process is a CHAIN OF COMMANDS** gated on record fields (`references/commands.md`),
  never a workflow entity — there is no workflow kind, deliberately: the record's own state is
  the progress marker.

domain work — meetings, patients, invoices, whatever this workspace is about — is owned by the
**module** that ships those collections; read that module's own skills. core knows entity kinds
and `repos`, and deliberately nothing else. workspace-level rules live in `CLAUDE.md`, and a
workspace's decision log (where one exists) wins over older documents.

## system entities take the RECORD verbs

Modules, collections, skills, agents, commands, command-bindings, ui-views and collection-templates
are collections in the runtime, and since 0.19.0 the ordinary verbs write them:

```
dt add modules --name core --description "The shared nouns."
dt add collections --name people --module core --description "A person."
dt add-field people --name email --type string --description "Where to write to them."
dt rename-field people --name email --to work_email
dt set collections/people module=hr          # MOVES it to another module
dt set modules/hr namespaces=hr dependencies=modules/core
dt rm modules/hr --force                     # --dry-run first; it prints its plan
```

`dt schema <op>` is **gone** since 0.19.0 and fails with the translation printed. `UPDATING.md` has
the complete mapping table.

⚠ **ONE difference, and it is POLICY rather than spelling: a SYSTEM write commits itself; a RECORD
write does not.** An uncompilable or unpublished schema is not a state a workspace should sit in, so
every system verb writes its source, proves it with a real compile, and commits — **in the repo that
holds the source**, so a write into a `git_modules/` module commits there and says
`ahead 1 — push when ready`. A record write lands on disk and `dt commit` publishes it.

⚠ **Every verb that moves records or clears values takes `--dry-run` and prints its plan first:**
`rename collections/…`, `rename-field`, `remove-field`, `set collections/… module=`,
`rm modules/… --force`. The plan line is one shape — `records N · refs M · descriptors K · values
cleared V` — so two dry runs are comparable, and a term that reads 0 means zero rather than
unmeasured (where a number genuinely cannot be known before the run, the plan says so in words).

## the rules that hold in both acts

1. **sources live in a module** — `modules/<module>/<kind>/`; the workspace's own go in its
   workspace module. **a module is discovered by its `package.json` carrying a `dreamteamer`
   key** (`"dreamteamer": {}` is enough) — without it, the folder is silently ignored.
2. **the filename is the id.** where a record also carries a frontmatter `name` (agents,
   commands), the two must agree, or the id lies and dispatch misses.
3. **the meta-descriptor is the spec.** every source kind is itself a collection — read
   `.dreamteamer/collections/<kind>.collection.yaml`; its field descriptions are the contract.
   prose drifts, and a sample record is one arbitrary instance — when a schema underdocuments a
   convention, fixing the schema IS the task (`references/records.md`).
4. **`dt compile`, then `dt check`**, after any source change. compile fails closed — a bad
   source is rejected and the previous runtime stands; check reports and never modifies.
5. **a running session does not see new sources.** a new skill, command or agent is live in the
   operator's NEXT session — say so rather than letting them wonder.
6. **never edit generated output.** `.dreamteamer/`, `.claude/`, `.agents/`, `.cursor/` are
   overwritten and pruned on the next compile — if you found the thing to change there, you are
   in the wrong file.
7. **the CLI refuses system-stored records on purpose** (`dt set skills/<id>` — no): edit the
   module source and compile. the SYSTEM verbs are the sanctioned exception — they write
   sources *through* a compile gate, so an uncompilable source can never land.
8. **never duplicate a procedure across records.** a command body restating a skill, an agent
   inlining its skill's steps — two copies, and one drifts. reference the owner.
9. **nothing module-shipped names a person, an account or a machine path.** per-install values
   are `${env:VAR}` templates plus a declared var, rendered only by `dt resolve`
   (`references/records.md`).
10. **commit discipline: scope to what YOU wrote** — `dt commit <collection>/<id> …` — and never
    `git add -A`, `git add .` or `git commit -a`: a blanket add silently sweeps another session's
    pending work under your subject. commit when a logical change is complete — records via
    `dt commit`, sources via `git add <specific paths>`; `dt status` says what is pending, and
    `dt check` runs after bulk edits.

## common mistakes

| mistake | reality |
|---|---|
| editing under `.dreamteamer/` or `.claude/` | generated — the change vanishes next compile; find the module source |
| changing a source and not compiling | the CLI, `check` and every harness still read the stale runtime |
| hand-writing a record the CLI could add | skips validation, id generation and defaults |
| bare refs (`ada`, `data/contacts/x.contact.md`) | refs are `<collection>/<id>`; anything else fails check |
| assuming a write was committed | it was not (unless `auto-commit` is on) — `dt status` shows pending |
| learning flags from prose or memory | `dt help` is the surface; prose carries judgment only |
| a new module folder compile ignores | its `package.json` needs a `dreamteamer` key |
| `git add -A` in a shared tree | steals another session's uncommitted work, invisibly |
| an absolute machine path in a record | wrong on every other machine — `${env:NAME}` + a declared var |
| picking an entity by what is easiest to write | pick by how it should be TRIGGERED — that is what the choice encodes |
| telling the operator a new source works now | it works in their **next** session |
