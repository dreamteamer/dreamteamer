# @dreamteamer/dreamteamer

dreamteamer core — the workspace compiler, CLI and server, plus the self-referential minimum of
collections, skills and agents every workspace needs.

the contract: module sources (`system/` folders, discovered over three channels — inline
`modules/*` > `git_modules/*` > npm deps) compile **explicitly** into `.dreamteamer/`, the single
runtime read surface, and from there into per-harness adapters (claude-code, codex, pi, gemini-cli,
cursor). data is plain files: records are `<id>.<suffix>.<ext>`, ids are paths, references are
`<collection>/<id>`, every mutation is one git commit. hard validation before disk; nothing hidden.

```bash
npm i git+ssh://git@github.com/dreamteamer/dreamteamer.git   # engine + `dreamteamer` bin
dreamteamer init      # scaffold a workspace
dreamteamer compile   # sources → .dreamteamer (+ harness adapters)
dreamteamer check     # validate every record
dreamteamer start     # clean REST api + the studio at /admin
```

full documentation: [dreamteamer-docs](https://github.com/dreamteamer/dreamteamer-docs) ·
studio: [dreamteamer-studio](https://github.com/dreamteamer/dreamteamer-studio)

private repo; extracted from the hq3 dogfood workspace — full pre-extraction history lives there.
