---
name: building-dreamteamer
description: use when authoring or changing anything in a module's system/ folder — a collection or a field, a skill, a command, an agent, a workflow, a ui-view, or studio component code. Also when deciding WHICH of those a request should become, or when a compile/check error names a source file.
---

# building dreamteamer

**core principle:** you write a **source** under `modules/<module>/system/<kind>/`, `compile` makes
it real, `check` reports what disagrees. Nothing you author is live until compile runs, and nothing
under `.dreamteamer/` or `.claude/` is ever the thing to edit.

This skill is the **digest**. The shape of each entity, and the mistakes specific to it, live in
`references/` — load exactly the one you need.

## first: which entity is this?

Most authoring mistakes are a wrong choice here, not a wrong file. Pick by what the operator
actually wants to happen:

| the ask | write | reference |
|---|---|---|
| "the workspace has no home for this kind of thing" / a field is missing | a **collection** | `references/collections.md` |
| "when you're already doing X, know this" — knowledge a session should find itself | a **skill** | `references/skills.md` |
| "let me type one word and have you do this" | a **command** | `references/commands.md` |
| "do this with a fresh context and its own tools" | an **agent** | `references/agents.md` |
| an ordered process that pauses on a human | a **workflow** | `references/workflows.md` |
| "put it at this route / in the nav / show it as a board" | a **ui-view** | `references/ui-views.md` |
| a rendering or editing behaviour no registered component has | **component code** | `references/ui-components.md` |
| "which command applies to this record?" | a **command-binding** | `references/commands.md` |

Three tie-breakers worth internalising, because they are the ones that go wrong:

- **skill vs command:** a skill triggers itself when the situation arises; a command needs the
  operator to remember it exists. If the answer is "and they'd have to think of running it", write
  the skill.
- **agent vs skill:** an agent costs a whole context. If "just tell the current session how" works,
  it is a skill.
- **workflow vs command:** a command is *one turn of text*. The moment it needs to survive a pause,
  or a human has to approve something mid-way, it is a workflow.

## the rules that apply to every kind

These were duplicated across seven skills; they are true for all of them.

1. **Sources live in a module.** `modules/<module>/system/<kind>/`. The workspace's own go in its
   **workspace module** — the `dreamteamer.workspace-module` name in `package.json`. A root
   `system/` folder is a **compile error**, not a fallback.
2. **The filename is the id.** `<name>.<kind>.<ext>`, or a folder named `<id>` for folder-shape
   kinds (skills). Where a record also carries a `name` in frontmatter (agents, commands,
   workflows), the two **must agree** — the harness names the file from the filename, so a mismatch
   makes the id lie.
3. **The meta-descriptor IS the spec.** Every kind is itself a collection:
   `.dreamteamer/system/collections/<kind>.collection.yaml` lists every key it may carry with its
   allowed values. Read that, plus a real one (`dt <kind> get <id>`), instead of learning the shape
   from prose. Prose drifts; the descriptor cannot.
4. **`npm run compile`, then `npm run check`.** Compile materializes the runtime and the harness
   adapters; check validates refs and shapes and never modifies files. Neither is optional.
5. **A running session does not see new sources.** Compile writes files; it cannot reach into a
   conversation already in progress. A new command, agent or skill is available in the **next**
   session. Say so rather than letting the operator wonder.
6. **References are qualified** — `skills/<id>`, `agents/<id>`, `commands/<id>`, `collections/<id>`,
   `users/<id>`. A bare name fails `check`.
7. **Never edit generated output.** `.dreamteamer/`, `.claude/`, `.agents/`, `.cursor/` are all
   overwritten and pruned on the next compile. If you found the thing you want to change in one of
   those, you are in the wrong file.
8. **The CLI refuses system-stored records on purpose.** `dt skills set …` will not work; edit the
   module source and compile. The exceptions are the meta verbs that write sources *through* a
   compile gate — `collections add`, `<collection> add-field`, `ui-views add|set` — which exist so
   an uncompilable source can never land in history.
9. **Never duplicate a procedure across records.** A command body that restates a skill, an agent
   body that inlines its skill's steps, a workflow step that re-types a command's prompt — each is
   two copies that drift. Reference the one that owns it.
10. **Module-shipped entities must not name a workspace's own users, accounts or paths.** Use
    `@initiator` / `@me`, and read per-install values from `.env` naming the variable. A hard-coded
    `users/<someone>` does not resolve in anyone else's workspace.

## the loop

```bash
# 1. author the source under modules/<module>/system/<kind>/
npm run compile     # required — nothing is live before this
npm run check       # refs, shapes, id patterns
npm run --silent dt -- status    # when unsure whether the runtime is fresh
```

`compile` fails **closed**: a source that cannot compile is rejected and the previous runtime
stands. Read the error — it names the file and, for a collision or an unresolved ref, both sides.

## is this core, or is it a recipe?

If you are adding to the **engine's own** `system/`, the bar is higher than "useful". Core carries
only what the engine itself reads or the compile/check/run loop needs. Anything domain-shaped —
a collection about people, meetings, products, content — belongs in a module, and a *generic*
version of it belongs in the `recipes` repo rather than here. `system/collections/tasks.collection.yaml`
carries the test in its header comment: **does the engine read it?**

## common mistakes

| mistake | reality |
|---|---|
| authoring under `.dreamteamer/` or `.claude/` | generated; the change vanishes on the next compile |
| a root `system/` folder | compile error by design — it goes in the workspace module |
| forgetting compile | the CLI, `check` and every harness still see the old shape |
| filename ≠ frontmatter `name` | the id lies; dispatch and invocation miss |
| telling the operator it works now | it works in their **next** session |
| writing a bespoke entity when a registered one would do | prefer a record over code, and an existing layout/skill over a new one |
| picking the entity by what is easiest to write | pick by how it should be triggered — that is what the choice encodes |
