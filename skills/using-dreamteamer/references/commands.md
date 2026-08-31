# commands and command-bindings — the typed verb, and the queue it implies

Two entities, one file each. A **command** is a canned prompt a human deliberately types
(`/<name>`). A **command-binding** joins a command to a collection under state gates, so every
(command, record) pair has an answerable state — which is what turns a collection into a work
queue without any run records.

What you write is consumed by three readers with different needs: the **operator** scanning the
`/` picker, who sees the `description` and `argument-hint` and nothing else; the **session** that
receives the body verbatim as its turn, and needs instructions, not documentation; and the
**surfaces** that render bindings — `dt commands <ref>`, the studio's Commands tab, and the
orientation block, which prints every binding's gates so each new session knows the queue exists
before any skill is loaded.

| the question | read |
|---|---|
| should this be a command at all | when a command earns existence |
| the file and its frontmatter | command mechanics |
| the body | prompt craft |
| what gets typed after the name | argument design |
| which records it applies to, and when | bindings |
| gates that stay honest | designing the gates |
| a multi-step process | the chain |

## when a command earns existence

A command needs the operator to remember it exists. That is both its defining weakness — a
capability behind a command the operator forgot is a capability the workspace doesn't have — and
its defining feature: some acts should only happen when a human decides they happen.

So the trigger decides the entity: when the right moment is a **human decision** ("process the
inbox now", "prepare me for tomorrow"), write the command. When the right moment is **recognizable
from the situation** — a recording appears, a record is about to be committed — write the skill,
which triggers itself; behind a command it would fire only when remembered. When the job needs a
fresh context or enforced tool limits, that is an agent (`agents.md`).

A command is also the cheap interface: one typed word in front of a procedure a *skill* owns. Most
good commands are a few lines — load the skill, name the scope, define done — and the skill does
the knowing.

## command mechanics

`modules/<module>/commands/<name>.command.md`. The filename equals the frontmatter `name` and is
what the operator types. Compile copies the file **verbatim** to `.claude/commands/<name>.md`
(stamped) — that file is what makes `/<name>` work, and the pass-through frontmatter keys flow
straight to the harness untouched. Harnesses without native command discovery get a
`/<name> — description` index in their orientation block instead.

```markdown
---
name: process-inbox
description: triage every open task assigned to me, one at a time
argument-hint: "[assignee]"
---
load this workspace's tasks skill. list my open tasks
(`npx dreamteamer list tasks --filter status=todo`), then walk them one at a
time: restate it, ask me to keep / reassign / drop, apply the decision with `tasks set`.
done when the list is empty or I say stop.
```

| field | required | notes |
|---|---|---|
| `name` | yes | equals the filename; what gets typed |
| `description` | no | the **whole entry in the `/` picker** — say what running it does, for someone scanning |
| `argument-hint` | no | shown inline in the picker (`"[assignee]"`, `"<record-ref>…"`) |
| `allowed-tools` | no | narrower than the session's, when the command should be constrained |
| `model` | no | override; omit to inherit |
| `disable-model-invocation` | no | set when **only a person** may run it — the model then cannot invoke it on its own. Right for anything destructive or outward-facing (a publish, a send) |
| body (`prompt`) | in practice | sent **verbatim as the turn** — see prompt craft. Only `name` is schema-required, but a bodyless command sends an empty turn |

## prompt craft — the body is a turn, not documentation

The body is sent to a session as if the operator typed it. Write **imperatives to yourself**:

- **which skill to load** — the procedure lives there, referenced once ("load the tasks skill"),
  never restated. A body that restates a skill is two copies, and one drifts.
- **which records to touch** — the scope, with the runnable command that lists it.
- **what "done" means** — the end condition. A command without one runs until the session decides
  it is finished, which is a different thing.

The anti-pattern is a body *about* the command — "This command processes the inbox by…". The
session receiving it does not need a description of what is happening to it; it needs instructions.
If you find yourself writing in the third person, you are documenting, not commanding.

## argument design

`$ARGUMENTS` / `$1` are substituted by the harness with whatever was typed after the name;
`argument-hint` tells the operator what that should be.

The convention: a **record command** takes record ref(s) (`/transcribe-visit
health/visit-recordings/<id> …`); a **collection command** takes the collection name. Write record
commands to accept *several* refs and loop in the body — because a multi-select invocation from a
surface carries the **eligible refs only, space-separated**. That contract is deliberate: the UI
shows the invocation verbatim in an editable textarea, so what will run is exactly what is shown
and nothing is silently dropped.

## command-bindings — the methods on a type

`modules/<module>/command-bindings/<command>--<collection>.command-binding.yaml` — an m2m record:

```yaml
command: commands/transcribe-visit
collection: collections/health/visit-recordings
target: record                      # or `collection` for commands that need no record
can-enter: { recording_file: { _nempty: true } }
can-exit:  { transcript: { _nempty: true } }
description: audio present, not yet transcribed
```

What a binding buys: `dt commands <collection>[/<id>] [--ids a,b] [--json]` answers "what can I do
with this record right now"; the studio draws the same answer as buttons; and the orientation block
renders every binding with its gates **literally** (`/transcribe-visit (enter: recording_file set ·
exit: transcript set)`) — so the gate you write is also documentation every session reads without
loading anything.

Each record gets one of three states, evaluated in this order:

| state | meaning | evaluation |
|---|---|---|
| `done` | the command's post-condition already holds | `can-exit` passes — **checked first**, so a record satisfying both gates reads done, not available |
| `available` | ready to run | `can-enter` passes (or no `can-enter`), and `can-exit` doesn't |
| `not-applicable` | not this record's moment | `can-enter` fails, or the record doesn't resolve |

Done renders **completed** — a check mark, not a bare grey mystery button: the operator sees work
that happened, and the button is not offered to run again. `target: collection` bindings evaluate
no record: always runnable, and the invocation
carries the collection name — so a command bound to several collections knows where to write.

Compile holds the referential ground: a binding naming an unknown command or collection **fails
compile**; an unknown filter operator in a gate **fails compile** (never silently narrows at
runtime); a `can-enter`/`can-exit` on a `target: collection` binding warns — there is no record to
evaluate it against.

## designing the gates

The design principle behind all of it: **the record's own fields are the progress marker.** No run
records, no job table — a workflow-run layer existed, was gate-tested through full lifecycles, and
was removed after measurement showed real work never used it. The gates only work if the fields
they read stay honest:

- **Pick the provenance signal, not the content signal.** "Is it transcribed?" is
  `transcription._nempty` — the provenance object — NOT `transcript._nempty`: a body can be filled
  by hand with no provenance, and that is exactly the case worth still flagging as not-done.
- **Filters reach one hop OUTBOUND**: `{ recording: { transcript: { _nempty: true } } }` resolves
  the ref and evaluates the sub-condition on the target; array refs use any-match semantics. A
  dangling ref, an unknown collection or a non-ref value **narrows, never widens** — a broken gate
  makes the command unavailable, not accidentally available.
- ⚠ **Inbound refs are unsupported** — "a summary referencing this record exists" is inexpressible
  as a filter over the record itself. Two honest answers: give the relation a **generated mirror**
  (`data-modeling.md` Part VI), which turns the inbound fact into a local field —
  `{ summary: { _nempty: true } }` works the moment `summary` is a mirror — or ship the binding
  without a `can-exit` and accept that it never shows done. What is not honest is a proxy field a
  human must remember to set.
- **The binding's `description` is the state pair in words** ("audio present, not yet
  transcribed") — it renders beside the button and in `dt commands` output (the orientation block
  carries the gates themselves), so write it as the answer to "why is this available".

## the chain — multi-step processes

There is no workflow kind, deliberately (the digest carries the story). A multi-step process is a
**chain of commands wired by shared fields: step N's `can-exit` is step N+1's `can-enter`.**

```yaml
# step 1 — transcribe--visit-recordings.command-binding.yaml
can-enter: { recording_file: { _nempty: true } }
can-exit:  { transcript: { _nempty: true } }

# step 2 — summarize--visits.command-binding.yaml   (gates one hop through the ref)
can-enter: { recordings: { transcript: { _nempty: true } } }
can-exit:  { summary: { _nempty: true } }            # a generated mirror — the inbound fact, made local
```

The queue advances itself: completing step 1 is what makes step 2 available, with no state machine
anywhere — just fields. When the sequence needs a name, add one more command whose body invokes the
others in order; the bindings still show per-step truth.

## common mistakes

| mistake | reality |
|---|---|
| filename ≠ `name` | the invocable name comes from the filename; the id then lies |
| a body that restates a whole skill | say "load `<skill>`" — one copy of the procedure |
| a body that describes the command | it is sent verbatim as a turn; write imperatives |
| no done condition in the body | the session decides for itself when it is finished |
| a command for something a skill should auto-trigger | commands fire only when remembered |
| a record command that takes exactly one ref | multi-select invocations carry several; loop in the body |
| gating on the content field instead of the provenance field | a hand-filled body reads done with nothing verified |
| a `can-exit` over an inbound ref | unsupported — use a mirror field, or ship without `can-exit` and say so |
| a `can-exit` on a `target: collection` binding | there is no record to evaluate; compile warns |
| a destructive command the model may invoke | set `disable-model-invocation` — some verbs are human-only |
