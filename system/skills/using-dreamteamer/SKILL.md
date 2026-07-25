---
name: using-dreamteamer
description: always load first — describes this dreamteamer workspace, its collections, conventions and your pending tasks
---

# using dreamteamer

this is a **dreamteamer** workspace: collections, skills, agents and workflows are records
compiled from sources into a runtime the harness reads.

**core principle:** read the compiled runtime, write the sources, compile, one commit per
mutation.

## when to use

load this **first, every session** in this repo. reload mid-session on any of these symptoms:
you're about to guess a collection's fields; you can't tell whether the file to edit lives
under `modules/*/system/` or `.dreamteamer/`; you wrote something and the harness didn't notice;
you're unsure which skill owns the job in front of you.

**not for:** the details of any one job — this is the map, not the procedure. record CRUD is
`working-with-structured-data-files`; schema changes are `writing-collections`.

## the contract

| concern | where | rule |
|---|---|---|
| schemas (read) | `.dreamteamer/system/collections/*.collection.yaml` | the single source of truth for what exists and its shape. **never edit under `.dreamteamer/`** — generated and gitignored |
| provenance | `.dreamteamer/manifest.yaml` | which module shipped which entry |
| sources (write) | `modules/<module>/system/` — **including the workspace's own** (`modules/hq3/system/`, the `workspace-module` in `package.json`) | a root `system/` is a compile ERROR (decision #22). same-name collisions across modules are compile errors too. after ANY source change: `npm run compile` |
| content records | `data/<collection>/` | per each descriptor's `storage.path` |
| operational records | `state/<collection>/` | workflow-runs, workflow-triggers, module-registries, trigger cursor |

- a record is a `<id>.<suffix>.<ext>` file (or a folder, for folder-shape collections).
  **the id is the path** inside the collection folder minus suffix and extension — nested
  folders join in: `data/meetings/2026/07/standup.meeting.md` ⇒ id `2026/07/standup`.
- **references are `<collection>/<id>`** strings (`users/ada`) — always qualified,
  greppable, never a bare name and never a file path.

## the CLI is the front door

`npm run --silent dt -- help` is the command surface — don't learn the generic verbs and flags
from prose; prose drifts. it does **not** list the purpose-built verbs some collections have
(`workflows run`, `collections add`, `<collection> add-field`) — those live in the skill that
owns them, and a verb absent from `help` still works.

what you need to know *about* the CLI: collection verbs validate hard (invalid writes, including
unknown fields, are rejected before disk) **and commit for you** with the right subject — see
`working-with-structured-data-files`. `npm run compile` after every source change, `npm run
check` after bulk edits, `npm run --silent dt -- status` when you're not sure the runtime is
fresh.

## routing

| the request is about | load |
|---|---|
| reading / creating / updating / renaming a record | `working-with-structured-data-files` |
| tasks, assignment, gate tasks | `working-with-tasks` |
| a new collection or a field change | `writing-collections` |
| a repeatable multi-step process, to author | `writing-workflows` |
| starting / advancing / resuming a workflow run | `executing-workflows` — runs are created with `dt workflows run`, never `workflow-runs add` |
| a skill / agent / command / ui-view | `writing-skills` / `writing-agents` / `writing-commands` / `writing-ui-views` |
| studio component code | `writing-ui-components` |
| pulling records out of a transcript or thread | `analyzing-conversations` |
| "what changed while I was away" | `detecting-data-changes-via-git` |
| the workspace lacks the capability entirely | `discovering-new-capabilities` |

## conventions

- **every mutation is one git commit**, subject `dreamteamer: <verb> <detail>` — e.g.
  `dreamteamer: tasks add 2026-07-25--fix-login`. one logical change per commit; a rename and
  its reference rewrites are ONE commit.
- **validate after bulk edits**: `npm run check` reports violations and never modifies files.
- workspace-level rules (RAD over test suites, `DECISION-LOG.md`, `STATUS.md`, never commit
  media) live in `CLAUDE.md` — and the decision log wins over older documents.
- **session greeting** — surface the operator's inbox:
  `npm run --silent dt -- tasks list --assignee users/<user> --status todo` (the current user is
  a record in `data/users/`; match against `git config user.name`).

## common mistakes

| mistake | why it bites |
|---|---|
| editing something under `.dreamteamer/` | generated + gitignored; the change vanishes on the next compile |
| changing a source and not compiling | the harness and `check` still read the stale runtime |
| hand-writing a record the CLI could add | skips validation, id generation, defaults, and the commit |
| bare refs (`ada`, `data/users/ada.user.md`) | refs are `<collection>/<id>`; anything else fails check |
| batching several mutations into one commit | the per-record history is the audit trail; one mutation, one commit |
