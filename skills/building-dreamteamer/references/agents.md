# agents — a persona you pay a whole context for

`modules/<module>/agents/<name>.agent.md` — one markdown file whose filename MUST equal the
frontmatter `name`. Compile turns it into a dispatchable subagent definition with one real
transform (below), so the record *is* the subagent.

You are usually here for one of two reasons: deciding whether an agent is the right entity at all,
or authoring one. Either way, what you write is judged by three readers who are not you:

- the **dispatcher** — a harness or a master agent matching a request against `description`. That
  one line is the agent's entire discoverability;
- the **agent itself** — waking with your body as its system prompt, its declared skills, its
  declared tools, and **none of the caller's context**;
- the **caller** — who gets back only what the agent chooses to hand back, and must act on it.

| the question | read |
|---|---|
| should this be an agent at all | the economics |
| what compile does with the file | mechanics |
| the one line the dispatcher sees | the description |
| the body | the system prompt |
| tools, model, skills | the allowances |
| does it actually work | verification |

## the economics — when an agent earns a context

An agent costs a whole context per dispatch: the harness spins up a fresh session, loads the
declared skills, and the persona re-orients from zero before its first useful act. That cost buys
exactly four things, and a job that needs none of them should be something cheaper:

| the job needs | why an agent and nothing else delivers it |
|---|---|
| **isolation** — fresh eyes that must not share the caller's context | a reviewer or critic run inside the author's context inherits the author's blind spots; the empty context IS the value |
| **a narrower tool set, as a guarantee** | "read-only" enforced by allowlist, not by promise — a skill inherits whatever tools the session already has |
| **parallelism** — several independent subtasks at once | each needs its own context by construction |
| **routing** — a persona whose whole job is picking the right collection, skill or agent | the master-agent pattern; core's own `dreamteamer` agent is exactly this |

What does *not* justify one:

- **Size.** "It's a big task" — the current session can do big tasks; a skill tells it how.
- **Recurrence.** A situation that keeps arising wants a skill, which triggers itself.
- **A shortcut.** Something the operator deliberately types is a command.
- **A procedure.** Procedures live in skills; an agent *references* its skills, never restates
  them (rule 9 of the digest — two copies drift).

The tie-breakers, as tests: if "just tell the current session how" works, write the skill. If the
operator must remember to run it, write the command. Write the agent only when the fresh context is
a *feature* — independence, enforcement, parallelism — rather than an overhead.

## mechanics — what compile does with the file

- **Copies it to `.claude/agents/<name>.md`** (stamped as generated) with **one transform**: the
  `skills:` frontmatter list is not a key any harness understands, so compile deletes it and
  prepends a body line — *"ALWAYS load these skills (Skill tool) before acting: …"*. Everything
  else passes through verbatim.
- **Validates the skill refs.** A `skills:` entry naming a skill that is not in this compile is a
  **compile error**, not a dangling pointer — an agent cannot ship pointing at a skill its module
  forgot to bring. Self-containment with teeth: the module that ships the agent ships (or depends
  on) its skills.
- **Only claude-code gets native agent files.** The other harnesses' orientation blocks point at
  `.dreamteamer/agents/` and leave dispatch to whoever reads them. Write for the record, not for
  one harness's dispatch mechanics.
- Like every source: a new or changed agent exists in the **next** session, not this one.

| field | required | notes |
|---|---|---|
| `name` | yes | must equal the filename — this is the id, and dispatch misses when they disagree |
| `description` | yes | **when a dispatcher should pick this agent** — concrete triggers, never a role title |
| `tools` | no | the allowlist; give only what the job needs. Omit = the harness default set, which is broad |
| `model` | no | override (`sonnet`, `opus`, …); omit to inherit the session's |
| `skills` | no | qualified `skills/<id>` refs, verified at compile — loaded before the agent acts |

The body is the `instructions` field (`x-body: true`) and becomes the subagent's system prompt.

## the description — written for the dispatcher

The dispatcher sees the description and nothing else. A role title ("the research agent") gives it
nothing to match against; triggers do — the request shapes, symptoms, and words a caller would
actually use:

```yaml
# ✖ a role title — matches nothing in particular, so it matches wrongly
description: the review agent

# ✔ dispatch conditions — request shapes, concrete situations
description: dispatch when freshly-written records need checking against their collection's
  conventions before commit — a batch import, a bulk edit, records written by a new skill
```

Same discipline as a skill description (`skills.md`): conditions, not contents. A description that
summarizes what the agent will do invites the dispatcher to do it itself instead of dispatching.

## the body — a system prompt for someone with no memory of this conversation

The agent wakes knowing only what the body, its skills, and the dispatch prompt tell it. Three
parts, in order, and rarely more than a paragraph:

1. **What to read first** — the records, descriptors or files that orient it.
2. **What to do** — by reference to its skills, never by restating them. The body says *which*
   judgment to apply; the skill owns *how*.
3. **What to hand back — the return contract.** The most-omitted part, and the one the caller
   actually depends on. An agent whose body never states its output shape returns an essay, and
   the caller re-derives what it needed from prose. Name the shape: the verdict, the evidence,
   what was not checked.

A body growing past ~15 lines has swallowed a skill — extract the procedure into one and reference
it.

Two references worth copying. Core's `agents/dreamteamer.agent.md` — the only agent core ships —
shows the router shape: trigger description, tight tool list, one skill ref, one-paragraph body.
And the reviewer shape, annotated:

```yaml
---
name: record-reviewer
description: dispatch when freshly-written records need checking against their collection's
  conventions before commit — a batch import, a bulk edit, records written by a new skill
tools: [Read, Grep, Glob, Bash]          # no Write, no Edit — read-only is the guarantee
skills: [skills/using-dreamteamer]        # qualified; verified at compile
---
Load the skills above, then read the compiled descriptor of every collection the dispatch prompt
names. Sample the named records against them: field conventions, reference shape, id shape,
suspiciously empty required fields. Do not fix anything. Hand back one line per problem —
`<ref> — <what is wrong> — <the fix>` — then the list of records checked and found clean.
```

Why each line earns its place: the tool list omits Write/Edit because the *allowlist* is the
enforcement (the body's "do not fix anything" is only the explanation); the description names three
dispatch situations, not a title; the body is read → judge → hand back, with the return contract
concrete enough that the caller can act on it mechanically.

## the allowances — tools, model, skills

- **Tools**: subtract, don't add. Start from what the job cannot work without; a Write tool on a
  read-only reviewer is a footgun, and "it might need it" is how footguns ship. Omitting the key
  means the harness default — which is broad, and therefore also a choice.
- **Model**: omit to inherit. Override downward for cheap high-volume jobs (a formatter, a
  triager); override upward only when the job measurably fails on the default.
- **Skills**: one or two. Each ref is loaded on *every* dispatch — a per-invocation cost, which is
  why the procedure lives in the skill once instead of being pasted into both. Design the pair to
  be self-sufficient: a subagent cannot reliably ask the caller questions mid-flight, so what it
  needs must arrive in the body, the skills, or the dispatch prompt.

## verification

Compile + check prove the record is well-formed, not that the persona works. In the next session
(or from a fresh dispatch): give it a realistic task and judge the **result shape** — did it load
its skills, did the tool limits hold, and above all did it hand back the return contract, or an
essay? Reading your own agent definition proves nothing; the same rule as skills.

## common mistakes

| mistake | reality |
|---|---|
| a `description` that is a role title ("the research agent") | dispatchers match on triggers; say when to pick it |
| `skills: [using-dreamteamer]` | refs are qualified: `skills/using-dreamteamer` |
| pasting the skill's procedure into the body | two copies, one drifts; the body references, the skill owns |
| no return contract in the body | the agent returns an essay and the caller re-derives the answer |
| a broad `tools` list "just in case" | the allowlist is the enforcement — a Write tool on a reviewer is a footgun |
| creating an agent for a one-off instruction | a skill (recurring) or just doing it (one-off) is the right answer |
| creating an agent because the task is big | size is not isolation; a skill in the current session handles big |
| testing by reading the definition | dispatch it with a real task and judge what it hands back |
