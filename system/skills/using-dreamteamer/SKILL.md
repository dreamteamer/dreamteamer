---
name: using-dreamteamer
description: always load first — describes this dreamteamer workspace, its collections, conventions and your pending tasks
---

# using dreamteamer

this is a **dreamteamer** workspace: collections, skills, agents and commands are records compiled
from sources into a runtime the harness reads.

**core principle:** read the compiled runtime, write the sources, compile, one commit per mutation.

## when to use

load this **first, every session** in this repo. reload mid-session on any of these symptoms: you're
about to guess a collection's fields; you can't tell whether the file to edit lives under
`modules/*/system/` or `.dreamteamer/`; you wrote something and the harness didn't notice; you're
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
| schemas (read) | `.dreamteamer/system/collections/*.collection.yaml` | the single source of truth for what exists and its shape. **never edit under `.dreamteamer/`** — generated and gitignored |
| provenance | `.dreamteamer/manifest.yaml` | which module shipped which entry |
| sources (write) | `modules/<module>/system/` — **including the workspace's own**, the `dreamteamer.workspace-module` named in `package.json` | a root `system/` is a compile ERROR. same-name collisions across modules are compile errors too. after ANY source change: `npm run compile` |
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
(`collections add`, `<collection> add-field`, `repos ensure`) — those live in the skill that owns
them, and a verb absent from `help` still works.

what you need to know *about* the CLI: collection verbs validate hard (invalid writes, **including
unknown fields**, are rejected before disk) **and commit for you** with the right subject. `npm run
compile` after every source change, `npm run check` after bulk edits, `npm run --silent dt -- status`
when you're not sure the runtime is fresh.

## routing

| the request is about | load |
|---|---|
| a record — read, create, update, rename, delete | `references/records.md` |
| authoring anything under a module's `system/` — a collection, field, skill, command, agent, ui-view, or component code | `building-dreamteamer` |
| "what changed while I was away" | `references/git-events.md` |
| the workspace lacks the capability entirely | `building-dreamteamer` → `references/before-you-build.md` |

Domain work — meetings, contacts, tasks, content, design — is owned by the **module** that ships those
collections, not by core. Read that module's own skills. Core knows about entity kinds, `users` and
`repos`, and deliberately nothing else.

## conventions

- **every mutation is one git commit**, subject `dreamteamer: <verb> <detail>` — e.g. `dreamteamer:
  tasks add 2026-07-25--fix-login`. one logical change per commit; a rename and its reference
  rewrites are ONE commit.
- **never `git add -A`, `git add .`, or `git commit -a`.** stage explicit paths. more than one agent
  can be working in a tree, and a blanket add silently commits whatever another session has
  uncommitted right now — under your subject, leaving `git status` clean and the damage invisible.
  the CLI's own writes are pathspec-scoped for exactly this reason, which is why it is the preferred
  path for record writes.
- **validate after bulk edits**: `npm run check` reports violations and never modifies files.
- workspace-level rules live in `CLAUDE.md`, and a workspace's decision log (where one exists) wins
  over older documents.
- **session greeting** — surface the operator's inbox: `npm run --silent dt -- tasks list --assignee
  users/<user> --status todo`. ⚠ the current user is a record in `data/users/` whose id is
  `slug(git config user.name)`; when those disagree the inbox comes back **empty with no error**.

## common mistakes

| mistake | why it bites |
|---|---|
| editing something under `.dreamteamer/` | generated + gitignored; the change vanishes on the next compile |
| changing a source and not compiling | the harness and `check` still read the stale runtime |
| hand-writing a record the CLI could add | skips validation, id generation, defaults, and the commit |
| bare refs (`ada`, `data/users/x.user.md`) | refs are `<collection>/<id>`; anything else fails check |
| batching several mutations into one commit | the per-record history is the audit trail |
| `git add -A` in a shared tree | steals another session's uncommitted work, invisibly |
