# Attached repos (`repos`) vs git modules (`git_modules`)

Two different lifecycles, deliberately two different homes. This trips people up, so the reasoning is
worth writing down once.

## Git modules are config, and they have to be

A git module — a clone under `git_modules/`, whether it ships modules or is read as a record layer — is
declared in the workspace's `package.json` under `dreamteamer.git_modules` and restored by `dt install`
(`dt` is `npx dreamteamer`). A module published to npm is config too, for the same reason: `dt install
<package>` pins it in `package.json`.

They MUST live in config rather than in records, because of a genuine bootstrap ordering problem: a
fresh clone has no `.dreamteamer/`, therefore no compiled schemas, therefore no readable records — so
module clones have to be restorable *before* anything can be read.

```bash
dt install                          # make the checkout ready: restores git_modules/ from the lockfile map, compiles
dt install --clone <url> [name]     # add one
dt update                           # pull clones forward (ff-only on the lockfile ref)
```

What a clone NEEDS is installed from here too (0.46.0), the npm way: the entries of its `git_modules`
that provide a holder its committed `dreamteamer-exports.json` names — its dependencies, never the rest of
its list — each cloned once at the top-level `git_modules/<name>` and linked under the clone, so a project
attached as a record layer need not be redeclared by every workspace that reads it. Your declaration
overrides a clone's; a disagreement between clones nests a second copy; nothing is refused.

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
