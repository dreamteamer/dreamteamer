# exporting — the workspace for a reader that is not a coding agent

`compile` renders the runtime for harnesses that read files. `dt export <target>` renders it for a
consumer that does not: today **NotebookLM**, which holds a bounded number of *sources* per notebook
and takes its standing instructions as a 10,000-character *persona*. `dt help` has the flags; this
page has the judgment.

## what travels, and what never does

Sensitivity is SCHEMA, decided once where the field is declared — never a flag on the export and
never inferred from a field's name (`email` travels unless somebody marked it):

- **a whole collection**: `dt set collections/<c> sensitive=true`. No record of it is written; the
  schema source and the persona NAME the omission so the reader knows the gap is deliberate.
- **one field**: `dt add-field <c> --name <f> … --sensitive`, or `dt set-field <c> --name <f>
  --sensitive` (`--sensitive false` clears). The field is projected out of every record.

Also never exported as records: the system collections (they ARE the schema source) and `codec: file`
collections (bytes a view draws). **Before the first export of a workspace, read the report** — it
prints every field that WAS exported per collection; that list is the review.

## what a notebook gets

- **`dt · schema`** — one source: workspace → module → collection → field, one heading level per
  step, with each collection's `use when`, id shape and every field's type, enum values and reference
  target. The lexicon the persona cannot afford in full.
- **`dt · <collection>`** — one source per collection, `## <collection>/<id>` per record, references
  rendered as `companies/acme (Acme Ltd)`. Over `--max-words` it shards into `dt · <c> [n/m]`.
- **the persona** — a Markdown template with `{{workspace}}` `{{schema_brief}}` `{{sources}}`
  `{{omitted}}` `{{exported_at}}` `{{engine_version}}` `{{schema_title}}` `{{collections}}`; the
  engine ships a default, `--instructions <file.md>` replaces it, an unknown placeholder is an
  error. `--response-length` and `--mode` ride along to `notebooklm configure`.

**The budget is the plan's source cap** (`--plan standard|plus|pro|ultra|<n>`, default `standard` =
50). Too many sources is a refusal that names the count and the remedies — nothing is dropped
quietly. A workspace with more collections than the plan has sources narrows with `--collections`.

## syncing

Without `--notebook`/`--create` the export is a pure render into `--out` (default
`.cache/dreamteamer/notebooklm/`, gitignored) and touches no network. With one, it makes the notebook
match **by title**: adds new sources, replaces those whose content hash changed, removes its own stale
ones (the `dt · ` prefix marks ownership — a source added by hand is never touched), then applies the
persona. `notebook.json` in the out dir keeps the notebook id and per-source hashes, so the second run
is incremental and `--create` is needed once. Every vendor call names the notebook with `-n`;
`notebooklm use` is never run. **Preflight is `notebooklm auth check --test`** — the bare check
reports a stale session as valid — and an expired login is the operator's to renew (`notebooklm
login` opens a browser).

## asking

Not a verb here. Ask with `notebooklm ask -n <id> --json`, and treat an answer as real only when it
has non-blank text AND at least one reference — exit 0 with an empty answer is a known shape.
