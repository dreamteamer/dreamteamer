---
name: writing-workflows
description: use when the operator describes a repeatable multi-step process (agent steps, human review gates) that should become a workflow record
---

# writing workflows

a workflow is a yaml record — `modules/<module>/system/workflows/<name>.workflow.yaml`, the
workspace's own in the workspace module (`modules/hq3/system/workflows/…` here) — an ordered list
of steps over one collection.

**core principle:** a step is the unit of progress AND the unit of pause. one operator per
step, prose prompts, no branch DSL.

## when to use

the operator describes something they do repeatedly with the same shape ("every time a
recording lands I…"), especially when it mixes agent work with a human review point, or when a
sequence keeps getting re-explained from scratch. symptoms: "then I always…", "and then I check
it before…", a checklist pasted twice.

**not for:** a one-shot multi-step job (just do it), knowledge that recurs but has no ordered
progression (`writing-skills`), a canned prompt the operator types (`writing-commands`), or
*running* a workflow (`executing-workflows`).

## shape

```yaml
name: do-research                       # matches the filename; this is the id
collection: collections/research-docs   # what it operates on — QUALIFIED ref
inputs: [items]                         # the selected / triggering items
steps:
  - id: research                        # A COMMAND STEP — the default shape
    command: commands/deep-research     # prompt, operator and done-when all come from it
  - id: publish
    command: commands/publish-doc
    via: project                        # acts on item.project, not the item itself
  - id: review                          # AN INLINE STEP — for what isn't a command
    operator: { human: users/ada }      # exactly ONE user, never a team
    prompt: review the findings; set status.  # module-shipped workflows use "@initiator"
    done-when: "status != draft"              # machine-checkable where possible
```

required: `name`, `steps`; per step `id`, plus **either `command` or `operator`+`prompt`** — exactly
one of the two (the schema's `oneOf`). `commands/…`, `agents/…`, `skills/…`, `users/…` and
`collections/…` are all `x-reference` fields — `check` fails if any doesn't resolve.

## rules

- **a workflow is a sequence of commands.** Prefer `command:` for anything a command already does;
  an inline prompt that restates a command's prompt is two copies that drift. The step inherits the
  command's prompt, its binding's operator, and **its binding's `can-exit` as the effective
  done-when** — so a step already satisfied is a no-op and a re-run is idempotent.
- **`via: <ref-field>` when the command acts on a neighbour.** A workflow over captures whose
  summarize command is bound to `meetings` uses `via: meeting`. `check` verifies the binding's
  collection matches the workflow's collection — or the `via` field's ref target — so a step can
  never point at records its command was never bound to.
- **write the command first.** A command step needs a `command-binding` joining that command to the
  right collection; without one `check` fails, because there would be nothing to inherit.
- **one operator per inline step** — either `agent` (+ the `skills` it should load) or a single
  `human`. never both, never a list of humans, never a team.
- **prompts are prose.** authoring a workflow should be as easy as writing a skill; concrete
  about records in and records out.
- **human steps become gate tasks** at run time (`executing-workflows`); give them a
  `done-when` expressed over record fields so an executor can verify it.
- **branching lives in a step prompt** ("if approved … if rejected …"), executed by
  `agents/workflow-orchestrator`. there is no branch DSL and adding one is not the answer.
- **module-shipped workflows must not name workspace users** — use `@initiator`, resolved at
  run time (manual runs → the invoker; triggered runs → the triggering commit's author).
- `modules/contact-management/system/workflows/process-recording.workflow.yaml` is the
  reference: three agent steps, each naming only the skills it needs, closing on an
  `@initiator` confirm gate.

## after writing

```bash
npm run compile     # required — the workflow isn't runnable until it's in the runtime
npm run check       # every operator/skill/collection ref must resolve
```

note: automation is deferred (decision #11) — workflows are attended-only, started by a
session, never auto-triggered. write them anyway; the trigger machinery reads the same records.

## common mistakes

| mistake | reality |
|---|---|
| bare `collection: research-docs` | reference fields are qualified: `collections/research-docs` (decision #6). |
| `operator: { agent: researcher }` | refs are `agents/<id>`, `skills/<id>`, `users/<id>`. |
| an agent step listing every skill in the workspace | list only what that step's job needs; skills cost context. |
| a human step with no `done-when` | nothing can verify the gate; the run stalls on judgement alone. |
| `operator: { human: teams/everyone }` | one named user, or `@initiator`. |
| a module workflow hard-coding `users/ada` | it won't resolve in anyone else's workspace. use `@initiator`. |
| inventing branch/loop keys (`if:`, `foreach:`) | not in the schema — express it in the prompt prose. |
| a step with both `command:` and `prompt:` | `oneOf` rejects it. the command owns its prompt; if you need to say more, say it in the command. |
| an inline step restating what a command already does | write the command step. two copies of a prompt is the thing E2 exists to remove. |
| a command step whose command has no binding on this collection | `check` fails — there is no operator, no target and no done-when to inherit. add the binding, or `via:` the hop. |
| a workflow that fans out over many items to "do everything" | one run per item. `dt sync` derives one event per record and fires one run each — that IS the fan-out. |
| authoring the run record by hand alongside the workflow | runs are created at execution time by `dt workflows run <id> --items …` (`executing-workflows`). |
