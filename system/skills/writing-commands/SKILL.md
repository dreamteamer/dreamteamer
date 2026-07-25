---
name: writing-commands
description: author command records (claude-code slash-command shape) that compile to .claude/commands/, invoked as /<name>
---

# writing commands

a command is a file record — `modules/<module>/system/commands/<name>.command.md`; the workspace's
own go in the workspace module (`modules/hq3/system/commands/…` here), never a root `system/`.

**core principle:** a command is a **canned prompt a human deliberately types**. the filename
(minus `.command.md`) IS the id, and compile copies the file verbatim to
`.claude/commands/<name>.md` — that file is what makes `/<name>` work.

## when to use

the operator keeps typing (or asking for) the same prompt and wants a one-word shortcut:
`/process-inbox`, `/standup`, `/triage`. symptoms: "can I just run X", the same paragraph
re-typed across sessions.

**not for:**

| the trigger is | write instead |
|---|---|
| "when I'm already doing X, know this" | a skill (`writing-skills`) — sessions load it themselves |
| an ordered process with review gates | a workflow (`writing-workflows`) |
| a persona with its own tools/context | an agent (`writing-agents`) |
| branching or state that must survive a pause | a workflow — a command is one turn of text |

## shape

```markdown
---
name: process-inbox
description: triage every open task assigned to me, one at a time
---
load the working-with-tasks skill. list my open tasks
(`npm run --silent dt -- tasks list --assignee users/<me> --status todo`), then walk them one
at a time: restate it, ask me to keep / reassign / drop, apply the decision with `tasks set`.
done when the list is empty or I say stop.
```

- **name** (required) — matches the filename. the `/` picker renders `description`, not `name`,
  but `name` is the id — keep it in sync.
- **description** — shown in the `/` picker; say what running it does.
- **body** = the `prompt` field (`x-body: true`) — the exact text sent as the turn. write it as
  an instruction to yourself: which skill to load, which records to touch, what "done" means.
- **`$ARGUMENTS`** — claude-code substitutes whatever the invoker typed after the command name.
  `/tasks-for gilad` with a body containing `$ARGUMENTS` sends that body with `$ARGUMENTS`
  replaced by `gilad`.

## after writing

```bash
npm run compile     # materializes .claude/commands/<name>.md
npm run check
```

the command appears in the `/` picker only in a session started **after** compile — an
already-running session won't pick it up mid-conversation.

## common mistakes

| mistake | reality |
|---|---|
| filename ≠ `name` | the invocable name comes from the filename; the id then lies. |
| a body that restates a whole skill | say "load `<skill>`" — one copy of the procedure, not two. |
| a body describing the command instead of instructing | it's sent verbatim as a turn. write imperatives, not documentation. |
| `description` that doesn't say what happens | it's the only thing the operator sees in the picker. |
| a command for something a skill should auto-trigger | commands need the operator to remember them; skills don't. |
| editing `.claude/commands/<name>.md` directly | generated — overwritten and pruned on the next compile. |
| expecting a running session to see it | restart. compile only writes the file. |
