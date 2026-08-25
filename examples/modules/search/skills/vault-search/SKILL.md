---
name: vault-search
description: use when you need to FIND records by what they say rather than by field values — "which meetings mention churn", "notes about invoicing", any question where `dt <c> list --where` can't help because the answer is in prose, or where you don't know which collection holds it. Full-text search over every record in the workspace, ranked, cross-collection.
---

# vault-search

Full-text search over every record, as refs. FTS5 via node:sqlite (Node ≥ 22.13), zero
dependencies; the index is a gitignored cache beside this file, rebuilt when the data changes.

```sh
node modules/search/skills/vault-search/find.mjs "churn invoicing"
node modules/search/skills/vault-search/find.mjs "churn" --collection meetings --limit 5
node modules/search/skills/vault-search/find.mjs "churn" --where '{"status":"open"}' --json
```

Output is `<collection>/<id>` refs plus a snippet — feed them straight to `dt get`, `dt history`,
`dt commands for`. `--where` takes the same operator set as `dt <c> list --where`, applied through
the engine's own matchesFilter, so typed filtering means exactly what it means everywhere else.

Worth knowing:

- Terms are OR-ed and bm25-ranked: more matching terms rank higher, one is enough to hit. You are
  the query expander — if "churn" finds nothing, probe "frustrated", "cancel", "at-risk"; each
  probe costs milliseconds.
- This is a MODULE SCRIPT (see the engine's `building-dreamteamer` → `references/module-scripts.md`):
  invoked by name only, writes nothing but its own `.cache/`, and logs each invocation there —
  usage is what decides whether this ever becomes a core verb.
