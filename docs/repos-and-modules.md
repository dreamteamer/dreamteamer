# Attached repos (`repos`) vs modules (`git-modules`)

Two different lifecycles, deliberately two different homes. This trips people up, so the reasoning is
worth writing down once.

## Modules are config, and they have to be

Modules are declared in the workspace's `package.json` under `dreamteamer.git-modules` and restored by
`dreamteamer install`.

They MUST live in config rather than in records, because of a genuine bootstrap ordering problem: a
fresh clone has no `.dreamteamer/`, therefore no compiled schemas, therefore no readable records — so
module clones have to be restorable *before* anything can be read.

```bash
dreamteamer install                          # restore git_modules/ from the lockfile map
dreamteamer install --clone <url> [name]     # add one
dreamteamer update                           # pull clones forward (ff-only on the lockfile ref)
```

## Attached repos are data

**Attached repos** are `repos` records under `data/repos/`. They contribute NOTHING to the workspace —
no schema, no skills, no UI. A repo record says only where a related git repo lives and how to get it,
and exists so that domain collections can reference `repos/<id>` instead of each inventing its own
url/ref/identity fields.

Because they are not needed at compile time, they get to be data — which buys hard validation, the
record CLI verbs, and history for free.

Working trees are materialized **on demand**:

```bash
dreamteamer ensure <id>     # clone if missing, print the path; idempotent
dreamteamer ensure --all    # explicit opt-in, e.g. before going offline
```

`install` deliberately does not do this. The record count only grows while the fraction any given
session needs only shrinks, so eager restore would make every fresh clone slow, would require every
identity's credentials to be present at install time, and would let one unreachable remote fail the
whole install. Lazy materialization fails only the action you asked for, at the moment you asked.

## Path resolution

`<repos-path>/<identity>/<name>`, where `repos-path` is a `package.json` `dreamteamer` key defaulting
to `projects`, and `identity` is optional (omit it for `<repos-path>/<name>`). A record's `path` field
overrides the derivation entirely.

**`identity` is an opaque path segment to the engine.** A workspace may use it to select a git identity
— via `~/.gitconfig` `includeIf` rules keyed on the path, for example — but that resolution happens
outside the engine, which only joins it into a path.

## A missing working tree is not a violation

`dreamteamer check` does not and must not flag it: a reference to `repos/<id>` resolves because the
RECORD exists, and whether the clone is on disk is irrelevant to referential integrity. Presence is
reported by `dreamteamer status`.
