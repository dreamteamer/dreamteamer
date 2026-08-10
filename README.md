# dreamteamer

A workspace compiler for coding agents. Module sources compile **explicitly** into `.dreamteamer/`,
the single runtime read surface, and from there into per-harness adapters — Claude Code, Codex, Pi,
Gemini CLI, Cursor. Data is plain files: records are `<id>.<suffix>.<ext>`, ids are paths,
references are `<collection>/<id>`. A write lands on disk; `dreamteamer commit` publishes it, one
commit per repo. Hard validation before disk; nothing hidden.

```bash
npm i dreamteamer         # engine + the `dreamteamer` bin
npx dreamteamer init      # scaffold a workspace
npx dreamteamer compile   # sources → .dreamteamer (+ harness adapters)
npx dreamteamer check     # validate every record
npx dreamteamer help      # the full command surface
```

There is a VS Code extension — [dreamteamer-vscode](https://github.com/dreamteamer/dreamteamer-vscode) —
which loads the engine **your workspace pins**, so the editor, the CLI and any agent session are
provably running the same code.

## Sources, and where they come from

A module contributes collections, skills, agents, commands, command-bindings, UI views and
collection templates. Modules are discovered over three channels, in precedence order: inline
`modules/*`, then `git_modules/*`, then npm dependencies. Sources live **flat at a module root** —
`modules/crm/skills/`, beside `package.json` — and an unknown folder at a module root is a compile
error rather than a silent skip.

## Attached repos (`repos`) vs modules (`git-modules`)

Two different lifecycles, deliberately two different homes.

**Modules** are declared in the workspace's `package.json` under `dreamteamer.git-modules` and
restored by `dreamteamer install`. They MUST live in config rather than in records because of a
genuine bootstrap ordering: a fresh clone has no `.dreamteamer`, therefore no compiled schemas,
therefore no readable records — so module clones have to be restorable before anything can be read.

**Attached repos** are `repos` records under `data/repos/`. They contribute NOTHING to the
workspace — no schema, no skills, no UI. A repo record says only where a related git repo lives and
how to get it, and exists so that domain collections can reference `repos/<id>` instead of each
inventing its own url/ref/identity fields. Because they are not needed at compile time, they get to
be data — which buys hard validation, the record CLI verbs, and history for free.

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
identity — via `~/.gitconfig` `includeIf` rules keyed on the path, for example — but that resolution
happens outside the engine, which only joins it into a path.

**A missing working tree is not a violation.** `dreamteamer check` does not and must not flag it: a
reference to `repos/<id>` resolves because the RECORD exists, and whether the clone is on disk is
irrelevant to referential integrity. Presence is reported by `dreamteamer status`.

## Domain modules are recipes, not packages

Anything domain-shaped — people, meetings, products, content — belongs in a module, and a generic
version belongs in a recipe a workspace **copies and adapts**. They are deliberately not installable
packages: four workspaces wanted a CRM and all four wanted a different `contacts`, so an import
would force one answer and make every divergence a fork.

## Contributing

Issues are welcome. For anything larger than a typo, please open a discussion before a pull request —
this is a small, deliberately lean codebase (`npm run metrics` enforces size budgets), and it's
better to agree on the shape first.

## License

Apache-2.0 © 2026 Gilad Khen. See [LICENSE](LICENSE).
