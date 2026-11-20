# Attached repos (`repos`) vs modules

Two different lifecycles, deliberately two different homes. This trips people up, so the reasoning is
worth writing down once.

## Modules are config, and they have to be

A module is either a folder under `modules/<id>/`, committed with the workspace, or a package `dt install
<spec>` pins in `package.json` (`dt` is `npx dreamteamer`; a spec may be a git URL).

They MUST live in config rather than in records, because of a genuine bootstrap ordering problem: a
fresh clone has no `.dreamteamer/`, therefore no compiled schemas, therefore no readable records — so
modules have to be installable *before* anything can be read.

## Attached repos are data

**Attached repos** are `repos` records under `data/repos/`. They contribute NOTHING to the workspace —
no schema, no skills, no UI. A repo record says only where a related git repo lives and how to get it,
and exists so that domain collections can reference `repos/<id>` instead of each inventing its own
url/ref/identity fields.

Because they are not needed at compile time, they get to be data — which buys hard validation, the
record CLI verbs, and history for free.

Working trees are materialized **on demand**:

```bash
dt install repos/<id>   # clone if missing, print the path; idempotent
dt install repos --all  # explicit opt-in, e.g. before going offline
```

Materializing a repo is never part of making a checkout ready — `dt install` with no target does
that, and it does not touch these. The record count only grows while the fraction any given session
needs only shrinks, so eager restore would make every fresh clone slow, would require every
identity's credentials to be present at that moment, and would let one unreachable remote fail the
whole thing. Lazy materialization fails only the action you asked for, at the moment you asked.

## Path resolution

`<repos_path>/<identity>/<name>`, where `repos_path` is a `package.json` `dreamteamer` key defaulting
to `projects`, and `identity` is optional (omit it for `<repos_path>/<name>`). A record's `path` field
overrides the derivation entirely. Both may be templates (`${env:NAME}`), rendered per machine — `dt resolve repos/<id> path`
shows a record's.

**`identity` is an opaque path segment to the engine.** A workspace may use it to select a git identity
— via `~/.gitconfig` `includeIf` rules keyed on the path, for example — but that resolution happens
outside the engine, which only joins it into a path.

## A missing working tree is not a violation

`dt check` does not and must not flag it: a reference to `repos/<id>` resolves because the
RECORD exists, and whether the clone is on disk is irrelevant to referential integrity. Presence is
reported by `dt status`.
