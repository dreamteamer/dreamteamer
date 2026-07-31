# agents

`modules/<module>/system/agents/<name>.agent.md`. The filename MUST equal the frontmatter `name`.
Compile copies the file to `.claude/agents/<name>.md` with one real transform — the `skills:`
frontmatter key becomes an in-body load instruction — so the record *is* the subagent definition.

**Before writing one, check it should not be a skill.** An agent costs a whole context. It earns
that only when the job needs a dispatchable persona with its own tool allowlist and skill set — a
router, a reviewer, an executor — or when a workflow step names an `operator.agent` that does not
exist yet.

```yaml
---
name: workflow-orchestrator
description: executes workflow steps and branching logic per the run-state contract; advances run records, creates gate tasks, resumes on gating-condition satisfaction
tools: [Read, Write, Edit, Grep, Glob, Bash]
skills: [skills/executing-workflows, skills/working-with-tasks]
---
```

| field | required | notes |
|---|---|---|
| `name` | yes | must equal the filename; this is the id and the subagent's identity |
| `description` | yes | **when a dispatcher should pick this agent** — concrete triggers, not a role title |
| `tools` | no | tool allowlist; give only what the job needs. Omit for the harness default |
| `model` | no | override (`sonnet`, `opus`, …); omit to inherit |
| `skills` | no | `skills/<id>` refs, verified by `check` — loaded before the agent works |

The body is the `instructions` field (`x-body: true`) and becomes the subagent's system prompt.
Direct instructions: what to read, what to decide, in what order, what it hands back. Keep it tight
— a few sentences to a short paragraph. **The procedure lives in the referenced skills**, never
duplicated here.

Reference: the core module's `system/agents/dreamteamer.agent.md` (the router) and
`workflow-orchestrator.agent.md` — short trigger description, tight tool list, 1–2 skill refs, a
one-paragraph body.

## common mistakes

| mistake | reality |
|---|---|
| a `description` that is a role title ("the research agent") | dispatchers match on triggers; say when to pick it |
| `skills: [executing-workflows]` | refs are qualified: `skills/executing-workflows` |
| pasting the skill's procedure into the body | two copies, one drifts |
| a broad `tools` list | a Write tool on a read-only reviewer is a footgun |
| creating an agent for a one-off instruction | a skill is usually the right answer |
