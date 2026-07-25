---
name: discovering-new-capabilities
description: find and propose an installable module when the workspace lacks a collection, skill, or workflow the operator needs
---

# discovering new capabilities

**core principle:** when the workspace can't do something, look before you build — then
**propose concretely, don't install silently.** the operator decides what enters their workspace.

## when to use

a request needs a collection, skill, workflow or agent this workspace doesn't have; the operator
asks "can this thing handle X"; you're about to author a bespoke one-off that smells like
something a module would ship (crm, calendar, transcription, scraping).

**not for:** the actual authoring once the decision is made — that's `writing-collections`,
`writing-skills`, `writing-workflows`, `writing-agents`.

## search order

| # | look at | what you're looking for |
|---|---|---|
| 1 | `modules/*/package.json` (`dreamteamer` section) + their `system/` trees | a capability already installed but unwired — this is the most common hit |
| 2 | `.dreamteamer/manifest.yaml` | what each module actually contributes today |
| 3 | `state/module-registries/*.module-registry.yaml` | registries the operator pointed at (`name` + `url`). a stub in v0.6 — expect zero records; that is not a dead end |
| 4 | `git_modules/` (restored by `npm run --silent dt -- install` from the `git-modules` lockfile in `package.json`) | a clone the operator already fetched — `install --clone <url> [name]` is how a new one gets there |

then **say what you found, plainly**. if nothing matches and the need is niche, say that too —
don't quietly build a bespoke one-off and present it as the only option.

## what "installing" actually means today

**three channels are compiled**, in precedence order: inline `modules/*` > `git_modules/*` >
npm deps whose package.json has a `dreamteamer` section (decision 24). so installing IS wiring:
`dreamteamer install --clone <url> [name]` clones into `git_modules/`, records the committed
`git-modules` lockfile entry, npm-installs/builds the clone — then `dreamteamer compile` lights it
up. `npm i <git-url>` works too (npm channel). the same module in two channels = the more-local
copy wins with a shadow warning; `dreamteamer status` shows per-module channel/ref provenance.

the working path is an **inline module**: `modules/<name>/` with its own `package.json`
(`dreamteamer: {}` section) and a `system/` tree — the exact shape of the core engine module and
`modules/contact-management` here. clone it (or copy it out of `git_modules/`) into `modules/`,
then:

```bash
npm run compile     # discovers modules/<name>, merges its system/ into .dreamteamer
npm run check
```

a module ships **schema and knowhow only** — nothing appears in `data/` or `state/` from an
install. compile does not create the data folders either; the first record written creates its
folder.

## reporting back

name the concrete thing: which module, which collections/skills/workflows it adds, the exact
steps to bring it in, and what it will NOT do. if nothing exists, say so and point at the
authoring skill as the next step — the operator chooses.

## common mistakes

| mistake | reality |
|---|---|
| "there's probably a module for that" | name it, or say nothing exists. vague hints waste the operator's turn. |
| telling the operator `npm install <git-url>` — or `install --clone` — lit a module up | compile only scans `modules/*`; a `git_modules/` clone is fetched, not wired. |
| installing / cloning without asking | capability changes are the operator's call. propose first. |
| skipping step 1 and going straight to authoring | the most frequent real answer is "already installed, just unwired". |
| building a bespoke collection for a whole domain (crm, calendar) | that's a module's job; a one-off descriptor becomes migration debt. |
| assuming an install populated `data/` | modules ship schema and knowhow only. |
| forgetting `npm run compile` after adding a module folder | nothing merged; the capability isn't live. |
