---
name: writing-agents
description: author agent records (claude-code subagent frontmatter, skill refs) that compile to .claude/agents/
---

# writing agents

an agent is a file record — `modules/<module>/system/agents/<name>.agent.md`; the workspace's own
go in the workspace module (`modules/hq3/system/agents/…` here), never a root `system/`.

**core principle:** the filename (minus `.agent.md`) IS the id and MUST equal the frontmatter
`name`. compile copies the file **with a real transform (the `skills:` frontmatter key becomes an in-body load instruction)** to `.claude/agents/<name>.md`, so the record
*is* the subagent definition — there is no translation layer to hide a mistake.

## when to use

the job needs a dispatchable persona with its own tool allowlist and skill set — a router, a
reviewer, a workflow executor — or a workflow step names an `operator.agent` that doesn't exist
yet.

**not for:** knowledge a session should load in place (`writing-skills`), a canned prompt the
operator types (`writing-commands`), an ordered process with gates (`writing-workflows`). if the
answer is "just tell the current session how to do it", write a skill instead — an agent costs
a whole context.

## frontmatter

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
| `tools` | no | claude-code tool allowlist; give only what the job needs. omit for the harness default |
| `model` | no | override (`sonnet`, `opus`, …); omit to inherit |
| `skills` | no | `skills/<id>` refs, verified by `npm run check` — the skills this agent loads before working |

## body

the body is the `instructions` field (`x-body: true`) — it becomes the subagent's system prompt.
write it as direct instructions: what to read, what to decide, in what order, what it hands back.
keep it tight (a few sentences to a short paragraph). **the procedure lives in the referenced
skills, not duplicated here** — duplication is how the two drift.

## reference

the core module's `system/agents/dreamteamer.agent.md` (the router: classify the request, load
the matching skill, execute or delegate) and `.../workflow-orchestrator.agent.md` (advances
workflow runs) show the pattern — short trigger description, tight tool list, 1-2 skill refs,
one-paragraph body.

## after writing

```bash
npm run compile     # materializes .claude/agents/<name>.md — not dispatchable until this runs
npm run check       # frontmatter shape + every skills/<id> ref resolves
```

a session already running won't see a newly compiled agent mid-conversation.

## common mistakes

| mistake | reality |
|---|---|
| filename ≠ frontmatter `name` | the harness names the file from the filename; dispatch then misses. |
| a `description` that's a role title ("the research agent") | dispatchers match on triggers. say when to pick it. |
| `skills: [executing-workflows]` | refs are qualified: `skills/executing-workflows`. check fails otherwise. |
| pasting the skill's procedure into the body | two copies, one drifts. reference the skill. |
| `tools: [*]` / omitting nothing | give the minimum the job needs; a Write tool on a read-only reviewer is a footgun. |
| creating an agent for a one-off instruction | agents cost a full context. a skill is usually the right answer. |
| editing `.claude/agents/<name>.md` directly | generated output — overwritten and pruned on the next compile. |
| forgetting `npm run compile` | the record exists, the subagent does not. |
