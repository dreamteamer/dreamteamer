---
name: executing-workflows
description: use when starting, advancing, or resuming a workflow run, or when a gate task was completed and its run is waiting
---

# executing workflows

**core principle: the invariant is the data, not the process.** a `workflow-runs` record holds
the entire execution state, so any executor honoring this contract can advance a run — and runs
survive executor death, because the state is files in git. in this phase that executor is YOU,
the attended session.

## when to use

starting a workflow on some items; picking up a run that's `running` or `waiting`; a gate task
just got completed and its run is `waiting-on` it; a run failed and needs closing out.

**not for:** authoring the workflow itself (`building-dreamteamer`), the gate task's own
conventions (`working-with-tasks`), or trigger evaluation (`dreamteamer sync` creates runs
from data changes — decision 38; see `using-dreamteamer` → `references/git-events.md`). sync CREATES runs;
advancing their steps is this skill's job, in a session.

## the run record — `state/workflow-runs/<id>.workflow-run.yaml`

the field shape is the compiled descriptor,
`.dreamteamer/system/collections/workflow-runs.collection.yaml`; a real, finished run reads back
with `npm run --silent dt -- workflow-runs get <id>`. read one before you touch one.

the part no schema pins down is **`steps`** — a map keyed by step id, whose entries carry
`status` (`pending` | `running` | `waiting` | `done` | `failed`), `started`/`finished` timestamps
(quoted), `session` (harness session id when known), `outputs` (a small map of what the step
produced — record refs, counts, a one-line summary) and `task` (the gate task ref, on human
steps). that map is the contract; keep it honest.

## starting a run — one command, and it is not `add`

```bash
npm run --silent dt -- workflows run <workflow-id> --items <collection>/<id>[,<collection>/<id>…]
```

`workflows run` is the ONLY way to create a run. it reads the workflow, validates every item
ref, generates the id and **seeds the whole `steps` map** with the first step already `running`.
`workflow-runs add` is the generic record verb: it will happily write a run with **no `steps`
map at all** — a run that claims to be `running` while saying nothing about where it is. that
record is worse than no record. same for hand-writing the yaml, or for `add`-ing and then
patching `steps` in by hand.

⚠ **`dt help` does not list `workflows run`** — its usage text covers the generic record verbs
only. that is a gap in the help text, not evidence the verb is missing. run it.

## two kinds of step

**a command step** — `command: commands/<id>`, optionally `via: <ref-field>` — is the normal shape,
because a workflow is a sequence of commands. It carries no prompt of its own; everything comes from
the command and its binding:

| the step needs | comes from |
|---|---|
| the prompt | the command record's body |
| the operator / skills | the command's own `allowed-tools` + whatever its prompt loads |
| the target record | the run's item — or `item.<via>` when `via` is set (`via: meeting` on a capture step runs the command against the linked meeting) |
| `done-when` | **the binding's `can-exit` filter** |

`done-when` on an inline step is a prose string; `can-exit` is a filter object. They are not the same
type and one is not copied into the other. For a command step you **evaluate the binding's `can-exit`
directly**:

```bash
npm run --silent dt -- <collection> list --where '<the can-exit json>' --json | grep '<the item id>'
```
or just `npm run --silent dt -- commands for <item-ref>` and read whether that command says `done`.
**A command step whose `can-exit` already holds is a no-op** — mark it `done` with an `outputs` note
saying it was already satisfied, and move on. That is what makes a re-run idempotent. A command whose
binding has no `can-exit` (the inbound-ref cases) can never self-verify; rely on the human gate.

**an inline step** — `operator` + `prompt` — is for the things that are not commands: human gates
above all. The schema enforces exactly one of the two shapes per step.

## the loop

| phase | do | commit subject |
|---|---|---|
| create | `workflows run …` (above) | committed by the CLI |
| agent step | mark it `running` + `started` (the first step already is); **act as the step's operator** — for a command step, resolve the command (and `via`) and follow its prompt; for an inline step, load its declared skills and follow the step prompt exactly. the work itself commits as ordinary data mutations | one commit per transition |
| agent step end | write `outputs` + `status: done` on the step, advance `current-step` | `workflow-runs set <id>` |
| human step | create the gate task, set the step `waiting` + `task:`, run `waiting` + `waiting-on:`, then **STOP** | `workflow-runs set <id>` |
| resume | verify the step's `done-when` against the records, mark it `done`, clear `waiting-on`, continue | `workflow-runs set <id>` |
| finish | `status: done`, `current-step: null` | `workflow-runs set <id>` |
| failure | step + run `failed`, reason in `outputs`; never delete partial work | `workflow-runs set <id>` |

top-level fields go through `dt workflow-runs set <id> <field>=<value>`; anything inside the
`steps` map is a direct edit of the run file, committed by you with the same subject.
abandoning a run you created by mistake: `dt workflow-runs rm <id>` (it will refuse while a gate
task references it — remove that first).

## the two hard rules

**one commit per run-record transition.** the run's history IS `git log` on that one file. a
batch of transitions in one commit destroys the audit trail — and a crash mid-batch leaves a
run whose file disagrees with reality.

**nothing stays alive.** a human step means: write the gate task, write the waiting state,
commit, and end your turn. pause costs nothing — a later session (or the operator saying "done")
resumes from the file. polling, sleeping, or "just waiting a moment" costs everything.

## gate tasks

assignee = the step's user (`@initiator` resolves to whoever started the run); body = the step
prompt; set both backlinks — `run: workflow-runs/<id>` and `item: <collection>/<id>`. see
`working-with-tasks`. **completing the gate task is what resumes the run — never delete one.**

## common mistakes

| mistake | reality |
|---|---|
| polling / sleeping until the human replies | the run is a file. stop your turn; resume later. |
| one commit covering several step transitions | `git log` on the run file is the history. one transition, one commit. |
| resuming without checking `done-when` | you'd advance a gate the records don't actually satisfy. |
| re-doing a command step whose `can-exit` already holds | it's a no-op — mark it done, say so in `outputs`. duplicate work is the bug idempotency prevents. |
| copying a binding's `can-exit` into the step's `done-when` | one is a filter object, the other a prose string. evaluate the filter; don't stringify it. |
| deleting a gate task to unblock | completion resumes the run; deletion orphans `waiting-on`. |
| leaving `status: running` while gated | `waiting` + `waiting-on` is how a later session knows what to pick up. |
| deleting partial work on failure | mark it `failed` and keep the evidence. |
| ISO timestamps written unquoted | quote them — an unquoted timestamp is a Date object to any default-schema YAML reader. |
| `dt workflow-runs add --workflow … --items …` to start a run | it's the generic verb: no `steps` map, nothing seeded, the run is born lying about its own state. `dt workflows run <workflow-id> --items …`. |
| hand-writing the run yaml to start a run | same gap, plus no ref validation and no id. |
| an id you invented instead of the CLI's | the `seq` counter is per-prefix; let `workflows run` compute it. |

## red flags — stop

- you typed `workflow-runs add` — that's not how a run starts
- you're about to wait, poll, sleep, or re-ask the same gate question
- you've made two run-record changes without a commit in between
- the run file says `running` but you're not currently doing that step
- you're closing a run without having run `npm run check`
