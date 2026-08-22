# dreamteamer

**Structured, modular memory for coding agents.**

Your agent already has a memory. You just can't see it — it's prose, in a black box somewhere,
untracked and unshared. And memory *is* context, which is the single biggest lever on what your agent
decides and how well it does it. So the most consequential thing in your setup is the one you have the
least access to.

dreamteamer makes it **files with a schema**: plain markdown in your git repo that your agent reads
natively, and that you can browse as tables, boards and forms.

```bash
npm i dreamteamer
npx dreamteamer init      # scaffold a workspace
npx dreamteamer compile   # sources → .dreamteamer (+ harness adapters)
npx dreamteamer check     # prove every record and every link is intact
npx dreamteamer help      # the full command surface
```

Apache-2.0. No server, no account, no telemetry.

## Structured

A record is a file. That's the whole trick.

```
data/meetings/2026/07/kickoff.meeting.md
```

```yaml
---
title: Kickoff
date: 2026-07-14
attendees: [contacts/ada, contacts/lin]
project: projects/apollo
---
Ada walked through the constraints. Lin owns the spec by Friday.
```

Your agent opens that file the way it opens any file. Nothing is intercepted, nothing is proxied,
there is no API to learn.

But `attendees` isn't a string — it's a link. `dreamteamer check` proves every one of them resolves,
and renaming `contacts/ada` updates everything pointing at it. A write with an unknown field, a wrong
type, or a reference to a record that doesn't exist is **rejected before it touches disk**.

**A schema is an agreement about what things are called.** Shared terminology with guardrails — not a
cage, because it stays negotiable. You change it by saying so:

> *"From here on a client has a renewal date, and it's a date."*

That's a schema update and a data migration, and it's an **explicit, reviewable event** rather than
silent drift. Once it exists you get the column in a table, the field in a form, validation, sorting
and aggregation — all of it falling out of having said what the thing is.

The shape of a record is deliberately dull, because dull is what survives:

- records are `<id>.<suffix>.<ext>` files; **the id is the path** inside the collection folder
- references are `<collection>/<id>` — always qualified, greppable, never a bare name
- a collection may be scoped under a **declared namespace** — `health/doctors/dana-levi`, stored in
  `data/health/doctors/`. The default namespace is the empty prefix, so `tasks/kickoff` is unchanged
- a write lands on disk; `dreamteamer commit` publishes it, one commit per repo
- schemas are JSON Schema in a YAML file, one per collection

### Machine-specific references

Some things a record points at only exist on one machine — a synced Drive folder, an external disk,
a checkout somewhere else. Those are written as **templates**, never as absolute paths:

```yaml
source_file: ${env:FILES_FOLDER}/2026/q3.pdf
```

Three variables, borrowing VS Code's grammar: `${env:NAME}` — declared in `dreamteamer.vars` in
`package.json`, valued in the gitignored `.env` — plus `${workspaceFolder}` and `${userHome}`.
One verb renders them:

```bash
npx dreamteamer resolve '${env:FILES_FOLDER}/x'            # → /Volumes/annex/x
npx dreamteamer resolve <collection>/<id> <field>          # render what a record already holds
```

**Templates are ordinary data — write them literally; nothing substitutes until `resolve` is
called.** `get`, `list`, `check` and every harness see the template verbatim, which is exactly what
makes the record mean the same thing on every machine instead of quietly meaning two things. An
undeclared key and a declared-but-absent one are different errors, and `compile` warns — by name,
never by value — when a declared var has nothing behind it here.

## Modular

**Data and skills are the new app structure.** A coding agent with the right skills over the right
data is arbitrary functionality — but composing that with no module system is where most setups stall.

So dreamteamer doesn't invent one. **It uses npm.**

`node_modules` is battle-tested, universally adopted, and already sitting in nearly every
coding-agent setup. A module contributes collections, skills, agents, commands, command-bindings and
UI views — and skills and agents are treated as exactly what they are: **memory that loads into
context**, living in the same module structure as everything else, in a standard your tooling already
understands.

Three channels, one shape:

```
modules/<name>/        # lives in this repo
git_modules/<name>/    # lives in its own repo
node_modules/<name>/   # published package
```

Precedence runs top to bottom, so a local copy shadows a published one — which is how you develop a
module and use it in the same workspace at the same time.

Sources live **flat at a module root** — `modules/crm/skills/`, beside `package.json` — and a folder
at a module root that isn't a known kind is a compile error rather than a silent skip.

### Modules are not rigid

This is the part that differs from npm on purpose.

Installing a module into a workspace that already has opinions — its own idea of what a `contact` is —
is a **negotiation, not an overwrite**. Four workspaces wanted a CRM and all four wanted a different
`contacts`. A hard import would force one answer and make every divergence a fork.

Two same-name collections is a compile error that names both descriptors and tells you the move:
declare `extends: <module>/<collection>` and overlay only what differs. Because every schema is one
small YAML file, adapting is cheap — read it, change what doesn't fit, and the diff shows exactly what
you agreed to.

So domain modules are **recipes you copy and adapt, not packages you install**, and divergence is the
normal case rather than a failure.

## Every harness, one source

`compile` writes `.dreamteamer/` — the single runtime read surface — and from there into per-harness
adapters: Claude Code, Codex, Pi, Gemini CLI, Cursor. Author a skill once; every agent you run sees it.

## The editor

[dreamteamer-vscode](https://github.com/dreamteamer/dreamteamer-vscode) gives you tables, boards,
calendars, maps, forms and a data-model designer over the same files — and it loads **the engine your
workspace pins**, so the editor, the CLI and any agent session are provably running the same code.

## Docs

This is an agent-native tool, so its documentation is shipped as skills the agent loads on demand —
and you can read them like any other file:

- [`skills/using-dreamteamer`](skills/using-dreamteamer) — the map: collections, conventions, the CLI,
  how records work
- [`skills/building-dreamteamer`](skills/building-dreamteamer) — authoring: collections, skills,
  agents, commands, UI views, and which of those a given request should become
- [`docs/repos-and-modules.md`](docs/repos-and-modules.md) — attached repos vs modules, and why they
  have different homes
- [`docs/namespaces-blast-radius.md`](docs/namespaces-blast-radius.md) — scoping collections under a
  namespace (`health/doctors`), what it costs consumers, and why the default namespace is transparent
- [`UPDATING.md`](UPDATING.md) — what to do when upgrading, one section per release

## What it isn't

Not a database — records are files and git is the history. Not a cloud service — there is no server
and no account. Not a note-taking app — it's the layer underneath one.

And it is **not** for data that needs row-level access control, field-level encryption, or provable
erasure. Git cannot do those, and pretending otherwise is how people get hurt. This is for
human-scale structured knowledge: thousands of records, not millions.

## Contributing

Issues are welcome. For anything larger than a typo, please open a discussion before a pull request —
this is a small, deliberately lean codebase (`npm run metrics` enforces size budgets), and it's better
to agree on the shape first.

`npm run verify` is the gate: import-layer direction, size budgets, and the test suite (tiers 1+2,
zero dependencies, a few seconds). See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 © 2026 Gilad Khen. See [LICENSE](LICENSE).
