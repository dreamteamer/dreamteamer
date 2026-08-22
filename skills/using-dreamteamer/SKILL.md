---
name: using-dreamteamer
description: always load first — describes this dreamteamer workspace, its collections, conventions and your pending tasks
---

# using dreamteamer

this is a **dreamteamer** workspace: collections, skills, agents and commands are records compiled
from sources into a runtime the harness reads.

**core principle:** read the compiled runtime, write the sources, compile — then `dt commit` to publish.

## when to use

load this **first, every session** in this repo. reload mid-session on any of these symptoms: you're
about to guess a collection's fields; you can't tell whether the file to edit lives under
`modules/*/<kind>/` or `.dreamteamer/`; you wrote something and the harness didn't notice; you're
unsure which skill owns the job in front of you.

**this file is the MAP, not the procedure.** Detail lives in two references beside it, loaded on
demand:

| load | when |
|---|---|
| `references/records.md` | reading, creating, updating, renaming or deleting any record — the CLI verbs, hand-writing rules, the hard rules about ids and renames |
| `references/git-events.md` | "what changed while I was away" — `dt changes`, and how record events are derived from git history |

## the contract

| concern | where | rule |
|---|---|---|
| schemas (read) | `.dreamteamer/collections/*.collection.yaml` | the single source of truth for what exists and its shape. **never edit under `.dreamteamer/`** — generated and gitignored |
| provenance | `.dreamteamer/manifest.yaml` | which module shipped which entry |
| sources (write) | `modules/<module>/` — **including the workspace's own**, the `dreamteamer.workspace-module` named in `package.json` | a source folder at the workspace ROOT is a compile ERROR. same-name collisions across modules are compile errors too. after ANY source change: `npm run compile` |
| content records | `data/<collection>/` | per each descriptor's `storage.path` |
| operational records | `state/<collection>/` | whatever a module declares there; core ships none |

- a record is a `<id>.<suffix>.<ext>` file (or a folder, for folder-shape collections). **the id is
  the path** inside the collection folder minus suffix and extension — nested folders join in:
  `data/meetings/2026/07/standup.meeting.md` ⇒ id `2026/07/standup`.
- **references are `<collection>/<id>`** strings — always qualified, greppable, never a bare name and
  never a file path.

## the CLI is the front door

`npm run --silent dt -- help` is the command surface — don't learn the generic verbs and flags from
prose; prose drifts. it does **not** list the purpose-built verbs some collections have
(`schema add-collection`, `schema add-field <collection>`, `ensure`) — those live in the skill that owns
them, and a verb absent from `help` still works.

what you need to know *about* the CLI: collection verbs validate hard (invalid writes, **including
unknown fields**, are rejected before disk) **and commit for you** with the right subject. `npm run
compile` after every source change, `npm run check` after bulk edits, `npm run --silent dt -- status`
when you're not sure the runtime is fresh.

## routing

| the request is about | load |
|---|---|
| a record — read, create, update, rename, delete | `references/records.md` |
| authoring anything under a module's source folders — a collection, field, skill, command, agent, ui-view, or component code | `building-dreamteamer` |
| "what changed while I was away" | `references/git-events.md` |
| the workspace lacks the capability entirely | `building-dreamteamer` → `references/before-you-build.md` |

Domain work — meetings, contacts, tasks, content, design — is owned by the **module** that ships those
collections, not by core. Read that module's own skills. Core knows about entity kinds and `repos`,
and deliberately nothing else — including nothing about people. There is no `users` collection.

## conventions

- **a write puts a record on disk; `dreamteamer commit` publishes it.** committing is POLICY —
  `"auto-commit"` in the workspace's `package.json`, default off — not a property of the write. so
  commit when a logical change is complete, and run `dt status` if you are unsure what is pending.
  subjects still read `dreamteamer: <verb> <detail>` for a single record (`dt commit` composes them
  from git's own status letters), and a multi-record commit says what it swept.
- **one commit per REPO.** a module can own its records (`owns-data` in its package.json), and git
  has no cross-repo commit — so a rename whose inbound refs live in another repo is TWO commits.
  `dt commit` prints both. `--dry-run` shows the set first.
- **scope the commit to what YOU wrote: `dt commit <collection>/<id>`.** any number of targets, each
  either a whole `<collection>` or one record — bare `dt commit` publishes everything pending, and
  `dt commit <collection>` publishes every dirty record under it *whoever wrote it*, which is the
  same sweep as the blanket add below when a second session shares the tree.
- **never `git add -A`, `git add .`, or `git commit -a`.** stage explicit paths. more than one agent
  can be working in a tree, and a blanket add silently commits whatever another session has
  uncommitted right now — under your subject, leaving `git status` clean and the damage invisible.
  the CLI's own writes are pathspec-scoped for exactly this reason, which is why it is the preferred
  path for record writes.
- **validate after bulk edits**: `npm run check` reports violations and never modifies files.
- workspace-level rules live in `CLAUDE.md`, and a workspace's decision log (where one exists) wins
  over older documents.
- **session greeting** — surface the operator's inbox from whatever collection this workspace uses for
  work, e.g. `npm run --silent dt -- list tasks --status todo`. ⚠ **there is no `users` collection and
  no `@me`** (both removed in 0.8.0); read the operator from `git config user.name` at the point you
  need one, and never filter on a person unless this workspace owns a collection of them.

## machine-specific references

a path that exists on only one machine — a synced folder, an external disk — is written as a
**template**, never as an absolute path:

```yaml
source_file: ${env:FILES_FOLDER}/2026/q3.pdf
```

| variable | renders to |
|---|---|
| `${env:NAME}` | `NAME`'s value in the workspace's `.env` — and only if `NAME` is listed in `dreamteamer.vars` in `package.json` AND has a non-empty value there (an empty or whitespace-only value fails exactly like an unset key) |
| `${workspaceFolder}` | the workspace root, absolute |
| `${userHome}` | the current user's home directory |

- **declare the key before using it**: `"dreamteamer": { "vars": ["FILES_FOLDER"] }`. an undeclared
  key and a declared-but-absent one are deliberately different errors — the first is a typo, the
  second is a machine nobody has set up. `npm run compile` warns per declared var with no value in
  `.env`, naming keys only.
- **render with `dt resolve`, the only substitution point**: `dt resolve '${env:FILES_FOLDER}/x'`, or
  `dt resolve <collection>/<id> <field>` to render what a record already holds (an array field prints
  one item per line). an argument containing `${` is always a template, so a ref-shaped one is never
  split as a reference.
- ⚠ **templates are ordinary data — write them literally; nothing substitutes until resolve is
  called.** `dt get`, `list`, `check` and every harness read the template verbatim. an un-namespaced
  `${VAR}` is inert, so prose may mention `${…}` freely.

## common mistakes

| mistake | why it bites |
|---|---|
| editing something under `.dreamteamer/` | generated + gitignored; the change vanishes on the next compile |
| changing a source and not compiling | the harness and `check` still read the stale runtime |
| hand-writing a record the CLI could add | skips validation, id generation and defaults |
| bare refs (`ada`, `data/contacts/x.contact.md`) | refs are `<collection>/<id>`; anything else fails check |
| assuming a write was committed | it was not, unless `auto-commit` is on — `dt status` says what is pending |
| `git add -A` in a shared tree | steals another session's uncommitted work, invisibly |
| an absolute machine path in a record | it is wrong on every other machine — write `${env:NAME}` and declare the key |
