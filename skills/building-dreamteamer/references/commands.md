# commands and command-bindings

## commands

`modules/<module>/system/commands/<name>.command.md`. A command is a **canned prompt a human
deliberately types**. Compile copies the file verbatim to `.claude/commands/<name>.md` — that file
is what makes `/<name>` work.

```markdown
---
name: process-inbox
description: triage every open task assigned to me, one at a time
argument-hint: "[assignee]"
---
load this workspace's tasks skill. list my open tasks
(`npm run --silent dt -- tasks list --assignee users/<me> --status todo`), then walk them one at a
time: restate it, ask me to keep / reassign / drop, apply the decision with `tasks set`.
done when the list is empty or I say stop.
```

- **`description`** is the only thing the operator sees in the `/` picker — say what running it does.
- **The body is the `prompt` field** (`x-body: true`) and is sent **verbatim as the turn**. Write
  imperatives to yourself — which skill to load, which records to touch, what "done" means — not
  documentation about the command.
- **`$ARGUMENTS` / `$1`** are substituted by the harness with whatever was typed after the command
  name. Pass-through frontmatter: `argument-hint`, `allowed-tools`, `model`,
  `disable-model-invocation`.
- **Convention:** a record command takes record ref(s) (`/transcribe-recording meetings/<id> …`); a
  collection command takes the collection name. A multi-select invocation carries the **eligible**
  refs only, space-separated, so nothing is silently dropped.

## command-bindings — which commands apply to which records

`modules/<module>/system/command-bindings/<command>--<collection>.command-binding.yaml`. An m2m
record joining a command to a collection, so **every (command, record) pair has a state**.

```yaml
command: commands/transcribe-recording
collection: collections/meeting-recordings
target: record                      # or `collection` for commands that need no record
can-enter: { file: { _nempty: true } }
can-exit:  { transcription: { _nempty: true } }
description: audio present, no transcript yet
```

- **`can-exit` doubles as the done-detector**, giving three states: `available` (enter ✓, exit ✗),
  `done` (exit ✓ — shown completed, not disabled), `not-applicable` (enter ✗). That is what makes
  the work queue **derivable from the data** rather than remembered.
- **Filters support one-hop OUTBOUND ref traversal**: `{ recording: { file: { _nempty: true } } }`
  resolves the ref and evaluates the sub-condition on the target. Array refs use `_some` semantics.
  A missing resolver, a dangling ref or a non-ref value **narrows**, never widens.
- ⚠ **INBOUND refs are unsupported.** "a summary referencing this meeting exists" is inexpressible,
  so a command whose completion is only visible from the other side ships without a `can-exit` and
  never shows done. Say so rather than faking it with a proxy field.
- **Pick the signal carefully.** "Is it transcribed?" is `transcription._nempty` (the provenance
  object), NOT `transcript._nempty` — a body can be filled by hand with no provenance, which is
  exactly the case worth flagging as not-yet-done.
- Read the queue with `dt commands for <collection>[/<id>] [--ids a,b] [--json]`.

## common mistakes

| mistake | reality |
|---|---|
| filename ≠ `name` | the invocable name comes from the filename; the id then lies |
| a body that restates a whole skill | say "load `<skill>`" — one copy of the procedure |
| a body that describes the command | it is sent verbatim as a turn; write imperatives |
| a command for something a skill should auto-trigger | commands need the operator to remember them |
| a `can-exit` on a `target: collection` binding | there is no record to evaluate it against; compile warns |
| a `can-exit` over an inbound ref | unsupported — the command will never report done |
