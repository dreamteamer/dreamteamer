# @dreamteamer/dreamteamer

dreamteamer core — the workspace compiler, CLI and server, plus the self-referential minimum of
collections, skills and agents every workspace needs.

the contract: module sources (`system/` folders, discovered over three channels — inline
`modules/*` > `git_modules/*` > npm deps) compile **explicitly** into `.dreamteamer/`, the single
runtime read surface, and from there into per-harness adapters (claude-code, codex, pi, gemini-cli,
cursor). data is plain files: records are `<id>.<suffix>.<ext>`, ids are paths, references are
`<collection>/<id>`. a write lands on disk; `dreamteamer commit` publishes it, one commit per repo
(a module can own its records). hard validation before disk; nothing hidden.

```bash
npm i git+ssh://git@github.com/dreamteamer/dreamteamer.git   # engine + `dreamteamer` bin
dreamteamer init      # scaffold a workspace
dreamteamer compile   # sources → .dreamteamer (+ harness adapters)
dreamteamer check     # validate every record
dreamteamer start     # clean REST api + the studio at /admin
```

## attached repos (`repos`) vs modules (`git-modules`)

Two different lifecycles, deliberately two different homes.

**Modules** are declared in the workspace's `package.json` under `dreamteamer.git-modules` and
restored by `dreamteamer install`. They MUST live in config rather than in records because of a
genuine bootstrap ordering: a fresh clone has no `.dreamteamer`, therefore no compiled schemas,
therefore no readable records — so module clones have to be restorable before anything can be read.
A module contributes schema, skills, agents, commands and UI to the workspace.

**Attached repos** are `repos` records under `data/repos/`. They contribute NOTHING to the
workspace — no schema, no skills, no UI. A repo record says only where a related git repo lives and
how to get it, and exists so that domain collections (`prototypes`, `apps`, …) can reference
`repos/<id>` instead of each inventing its own url/ref/identity fields. Because they are not needed
at compile time, they get to be data — which buys hard validation, the record CLI verbs, history,
and the studio for free.

Working trees are materialized **on demand**:

```bash
dreamteamer repos ensure <id>     # clone if missing, print the path; idempotent
dreamteamer repos ensure --all    # explicit opt-in, e.g. before going offline
```

`install` deliberately does not do this. The record count only grows while the fraction any given
session needs only shrinks, so eager restore would make every fresh clone slow, would require every
identity's credentials to be present at install time, and would let one unreachable remote fail the
whole install. Lazy materialization fails only the action you asked for, at the moment you asked.

Path resolution is `<repos-path>/<identity>/<name>`, where `repos-path` is a `package.json`
`dreamteamer` key defaulting to `projects`, and `identity` is optional (omit it for
`<repos-path>/<name>`). A record's `path` field overrides the derivation entirely.

**`identity` is an opaque path segment to the engine.** A workspace may use it to select a git
identity — hq3 does, via `~/.gitconfig` includeIf rules keyed on `projects/<identity>/` — but that
resolution happens outside the engine, which only joins it into a path.

**A missing working tree is not a violation.** `dreamteamer check` does not and must not flag it:
a reference to `repos/<id>` resolves because the RECORD exists, and whether the clone is on disk is
irrelevant to referential integrity. Presence is reported by `dreamteamer status`.

full documentation: [dreamteamer-docs](https://github.com/dreamteamer/dreamteamer-docs) ·
studio: [dreamteamer-studio](https://github.com/dreamteamer/dreamteamer-studio)

private repo; extracted from the hq3 dogfood workspace — full pre-extraction history lives there.
