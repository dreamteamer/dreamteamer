---
name: working-with-tasks
description: create, triage, assign and complete tasks; understand gate tasks
---

# working with tasks

tasks are md records in `data/tasks/` (`<id>.task.md`). **core principle:** a task is a record
created through the CLI — never a hand-written file — and its `assignee` is always exactly one
workspace user.

## when to use

the operator asks to create / assign / triage / complete a task or an action item; you're
extracting action items from a conversation; a workflow needs a human gate; you're surfacing
someone's inbox.

**not for:** authoring the workflow that creates gate tasks (`building-dreamteamer`), advancing a
run once a gate is done (`executing-workflows`), or the generic record rules
(`using-dreamteamer` → `references/records.md`; this skill only adds the task-specific conventions).

## the commands

the verbs and their flags are `npm run --silent dt -- help`; the record rules are
`using-dreamteamer` → `references/records.md`. task-specific:

- **`--title`, `--assignee`, `--due`, `--status`** on `add` — pass all four; `add` generates the
  id (`<creation-date>--<title-slug>`), materializes defaults and commits.
- **`--description "…"`** is the body (`x-body`) — pass it inline, or add the prose with an
  editor afterwards.
- **`--item` / `--run`** are the backlinks (see below).
- an inbox is a filtered list: `tasks list --assignee users/<id> --status todo`.

## fields that matter

- **assignee — always a single user** (`users/<id>`, a record in `data/users/`). never a team,
  never a contact, never a free-text name. resolve "me" / "the operator" by listing `users`
  and matching `git config user.name`; don't guess an id.
- when an action item belongs to someone outside the workspace (a client, a contact), leave
  `assignee` unset and name the owner in the body — and prefer folding it into the responsible
  user's task as a follow-up rather than letting it stand alone (decision #12).
- **due** — a `YYYY-MM-DD` date string. resolve relative phrases ("next friday", "eow") against
  today's actual date before writing; quote it if you're hand-editing YAML.
- **status** — `todo` | `doing` | `done`, materialized explicitly.
- **backlinks** — a task about a record sets `item: <collection>/<id>`; a task created by a
  workflow run sets `run: workflow-runs/<id>`.

## worked example

> "create a task for reviewing the Q3 roadmap, assigned to me, due next friday"

```bash
npm run --silent dt -- users list          # → giladkhen  giladkhen  giladkhen@gmail.com
date +%F                                    # → 2026-07-25 (a Saturday ⇒ next friday = 2026-07-31)
npm run --silent dt -- tasks add \
  --title "Review the Q3 roadmap" --assignee users/ada --due 2026-07-31 --status todo
# ✔ data/tasks/2026-07-25--review-the-q3-roadmap.task.md   (already committed)
```

## gate tasks

a gate task is an ordinary task created by a workflow's human step. completing it
(`status=done`) is *exactly* what resumes the run: the run record's `waiting-on` points at this
task, and the completion is an item-update the trigger machinery can see. **never delete a gate
task — complete it.** if the gate turned out to be wrong, complete it and note why in the body,
then fail or amend the run per `executing-workflows`.

## common mistakes

| mistake | reality |
|---|---|
| `assignee: contacts/jane` or `assignee: jane` | assignee is a `users/<id>` only. check fails otherwise. |
| `assignee: Gilad` / `assignee: users/gilad` | refs are exact record ids. run `users list` first. |
| hand-writing `data/tasks/<something>.task.md` | skips validation, defaults, the id pattern and the commit. use `tasks add`. |
| an id built from the **due** date | ids come from the creation date and never change; `due` is mutable. |
| `due: next friday` or `due: 31/07/2026` | `format: date` means `YYYY-MM-DD`. compute the real date. |
| deleting a gate task to unblock a run | the run resumes on completion, not deletion. set `status=done`. |
| committing after `tasks add` | `add` already committed. |
| omitting `status` | write it explicitly — files should read without the schema. |
