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
  - id: research
    operator: { agent: agents/researcher, skills: [skills/deep-research] }
    prompt: |
      natural-language instructions for the operator. be concrete about which
      records to read and which to write.
  - id: review
    operator: { human: users/ada }      # exactly ONE user, never a team
    prompt: review the findings; set status.  # module-shipped workflows use "@initiator"
    done-when: "status != draft"              # machine-checkable where possible
```

required: `name`, `steps`; per step `id`, `operator`, `prompt`. `agents/…`, `skills/…`,
`users/…` and `collections/…` are all `x-reference` fields — `check` fails if any doesn't
resolve.

## rules

- **one operator per step** — either `agent` (+ the `skills` it should load) or a single
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
| authoring the run record by hand alongside the workflow | runs are created at execution time by `dt workflows run <id> --items …` (`executing-workflows`). |
