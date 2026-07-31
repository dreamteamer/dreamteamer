# workflows

`modules/<module>/system/workflows/<name>.workflow.yaml` — an ordered list of steps over one
collection. **A step is the unit of progress AND the unit of pause.** One operator per step, prose
prompts, no branch DSL.

⚠ **Reach for a workflow last.** A command sequence a person runs, and command-bindings that make
the queue derivable, cover most of what looks like a workflow — and they cost no run records, no
executor and no gate machinery. A workflow earns its keep when the process must **survive a pause**:
a human approves something mid-way and the state has to be recoverable afterwards.

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
    operator: { human: '@initiator' }         # exactly ONE user, never a list, never a team
    prompt: review the findings; set status.
    done-when: "status != draft"              # machine-checkable where possible
```

Required: `name`, `steps`; per step `id`, plus **either `command` or `operator`+`prompt`** — exactly
one of the two (the schema's `oneOf`).

## rules

- **A workflow is a sequence of commands.** Prefer `command:` for anything a command already does;
  an inline prompt restating a command's prompt is two copies that drift. The step inherits the
  command's prompt, its binding's operator, and **its binding's `can-exit` as the effective
  done-when** — so a step already satisfied is a no-op, which is what makes a re-run idempotent.
- **`via: <ref-field>` when the command acts on a neighbour.** A workflow over captures whose
  summarize command is bound to `meetings` uses `via: meeting`. `check` verifies the binding's
  collection matches the workflow's collection or the `via` field's ref target, so a step can never
  point at records its command was never bound to.
- **Write the command first.** A command step needs a `command-binding` joining that command to the
  right collection; without one `check` fails, because there is nothing to inherit.
- **One operator per inline step** — either `agent` (+ the `skills` it should load) or a single
  `human`. Never both, never a list.
- **Human steps become gate tasks** at run time; give them a `done-when` expressed over record
  fields so an executor can verify it rather than waiting on judgement alone.
- **Branching lives in a step prompt** ("if approved … if rejected …"). There is no branch DSL and
  adding one is not the answer.
- **Module-shipped workflows must not name workspace users** — `@initiator` resolves at run time
  (manual runs → the invoker; triggered runs → the triggering commit's author).
- ⚠ **Never fan out inside a workflow.** One run per item. `dt sync` derives one event per record
  and fires one run each — that IS the fan-out. A "do everything" step whose collection is also
  trigger-armed processes every item twice.

## running one

`dt workflows run <workflow-id> --items <ref>` creates the validated run record — **never**
`workflow-runs add`, which writes a half-record. History is `git log` on the run record. Advancing a
run, resuming a parked one, and what a gate task means are `executing-workflows`.

## common mistakes

| mistake | reality |
|---|---|
| bare `collection: research-docs` | qualified: `collections/research-docs` |
| `operator: { agent: researcher }` | refs are `agents/<id>`, `users/<id>` |
| an agent step listing every skill in the workspace | skills cost context; list what the step needs |
| a human step with no `done-when` | nothing can verify the gate; the run stalls |
| inventing `if:` / `foreach:` keys | not in the schema — express it in the prompt prose |
| a step with both `command:` and `prompt:` | `oneOf` rejects it. The command owns its prompt |
| a command step whose command has no binding on this collection | nothing to inherit; `check` fails |
| authoring the run record by hand | runs are created at execution time |
