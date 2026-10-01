# descriptor format v2 — the engine plan

The design is an operator-side document ("Dreamteamer descriptor format v2 — one vocabulary, visible groups,
authored apart from compiled", revision 4, 2026-10-02). This file is the engine's build order against it:
one slice per row, each with the assertion that proves it, in dependency order. A slice is done when its
tests fail without it and pass with it, and `npm run verify:fast` is green. The full `npm run verify` runs
once, before the release commit. Backwards compatibility is out of scope by design: a v1 descriptor fails
compile naming the migration.

| # | slice | lands in | the assertion |
|---|---|---|---|
| 1 | one template grammar: parse · validate · render, five filters, built-ins `id` `created` `last_modified` (+ `seq` in id position) | `src/template.js` | `test/unit/template.test.js`: unknown filter / unknown field are errors naming the position; a reference token renders through a resolver in display position and as the id in id position; `generateId` unchanged |
| 2 | the field vocabulary → resolved fields + JSON Schema | `src/fields.js` (new) | `test/unit/fields.test.js`: every type maps per the table; `required` folds; `many`; enum map → list; `position` is a string with `^[a-z]+$`; `object`/`map`; `derived`/`virtual`; mirrors read-only; constraints → `allOf`; closed key list; **`json_schema.properties` equals fields minus virtual** |
| 3 | the nine meta-descriptors rewritten in v2 (`collection-templates` → `mixins`), each with `description` and `use_when`, no history | `collections/*.collection.yaml`, `src/init.js` | compile of the fixture workspace; a regex over every description for `\b20\d\d\b`, `\d+\.\d+\.\d+`, `decision \d+`, renamed, formerly, deprecated, rejected |
| 4 | compile reads v2: `fields`, `mixins`, `overlay: true`, `display`, `constraints`, `storage.shape/format/under.parent/subfolder`, `id.from`; emits `compiled{defaults, module, repo, runtime, under_collection, mirrors, overlaid_by, unresolved_peers, fields, json_schema}`; relations by `mirror_of` only; `unique` required on a scalar-mirror FK; rule 6 name validation; template validation; `descriptor_format` gate; namespaced `singular` with the fixed inflector; a v1 key fails naming its v2 key | `src/compile.js` | `test/integration/compile-v2.test.js`: the clinic fixture compiles; every §10 "shape and compile" assertion |
| 5 | records and store: validate against `compiled.json_schema`; `created` stamped at add, read lazily when absent; `derived`/`virtual` refuse writers; `editable` passes through; id collision named | `src/records.js`, `src/store.js` | `test/integration/store-v2.test.js` |
| 6 | check: `unique` values, `deprecated` counts, mirror staleness via `compiled.fields` | `src/check.js` | `test/integration/check-v2.test.js` |
| 7 | placement on `under.parent`/`subfolder`; relations on `mirror_of` | `src/placement.js`, `src/relations.js` | existing placement and relations suites, re-pointed |
| 8 | the display contract (§4.3): complete table, one word per meaning | `src/presentation.js` | `test/unit/presentation-*.test.js` rewritten; a test that lists every emitted key against the table |
| 9 | harness block: trigger line from `use_when` + neighbour clause; headings | `src/harnesses.js` | `test/integration/harness-block.test.js` |
| 10 | filter value tokens `$today`, `$now` | `src/filter.js` | `test/unit/filter.test.js` |
| 11 | CLI: `reorder` (was `move`), `fmt`, positional guard, `list` columns from `display.list`, help text | `src/collections-cli.js`, `src/cli.js` | `test/integration/verb-first-cli.test.js` extended; a positional key-and-flag check of help |
| 12 | schema-ops: field verbs write `fields`; `--enum`, `--many`, `--mirror-of <field>`, `--unique`, `--mixins`, `--id-from`, `--route`, `--scope`; `rename-field` reach; `rename-value` | `src/schema-ops.js` | `test/integration/schema-ops-v2.test.js` |
| 13 | docs: `using-dreamteamer` references (collections, data-modeling, ui-views, commands), the glossary, `UPDATING.md` v2 section | `skills/`, `UPDATING.md` | the skill-references test; no v1 key in the references |
| 14 | the migration script, AST-editing, comment-preserving, idempotent, never opens `data/` | `scripts/migrate-descriptors-v2.mjs` | `test/integration/migrate-v2.test.js` on a v1 fixture |
| 15 | metrics re-based with the three questions answered; `npm run verify` exit code quoted; the walk of §10's dev-host flow against the extension (separate repo) | `metrics.json` | — |

Rules that bind every slice: no vault name, no real record, no personal data in a fixture, a comment or a message
(the fixtures use the synthetic clinic); every system write edits the YAML AST through `writeSource`; compile
never writes a source.
