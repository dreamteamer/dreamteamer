# agents

`modules/<module>/agents/<name>.agent.md`. The filename MUST equal the frontmatter `name`.
Compile copies the file to `.claude/agents/<name>.md` with one real transform — the `skills:`
frontmatter key becomes an in-body load instruction — so the record *is* the subagent definition.

**Before writing one, check it should not be a skill.** An agent costs a whole context. It earns
that only when the job needs a dispatchable persona with its own tool allowlist and skill set — a
router, a reviewer, a critic that must not share the caller's context.

```yaml
---
name: dreamteamer
description: master agent — routes a request to the right collection, skill or agent; the default operator for data-facing work
tools: [Read, Write, Edit, Grep, Glob, Bash]
skills: [skills/using-dreamteamer]
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

Reference: the core module's `agents/dreamteamer.agent.md` — the only agent core ships, and the
shape to copy: short trigger description, tight tool list, 1–2 skill refs, a one-paragraph body.

## common mistakes

| mistake | reality |
|---|---|
| a `description` that is a role title ("the research agent") | dispatchers match on triggers; say when to pick it |
| `skills: [using-dreamteamer]` | refs are qualified: `skills/using-dreamteamer` |
| pasting the skill's procedure into the body | two copies, one drifts |
| a broad `tools` list | a Write tool on a read-only reviewer is a footgun |
| creating an agent for a one-off instruction | a skill is usually the right answer |
