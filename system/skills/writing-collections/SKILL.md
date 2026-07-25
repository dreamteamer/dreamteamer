---
name: writing-collections
description: use when creating a collection, adding/changing fields on one, or registering an existing folder of records that has no descriptor
---

# writing collections

a collection is one descriptor file — `modules/<module>/system/collections/<name>.collection.yaml`.
the workspace's own descriptors live in the **workspace module** (`modules/hq3/system/collections/`
here); a root `system/` is a compile error (decision #22). **core principle:** the descriptor
describes reality; you write the source, `npm run compile` makes it real, `npm run check`
reports what disagrees.

## when to use

the operator names a kind of thing the workspace has no home for; an existing collection needs a
new field or a widened enum; a folder of records exists under `data/` with no descriptor (drift —
register it same-day); `check` reports violations you suspect are schema-vs-reality mismatches.

**not for:** individual records (`working-with-structured-data-files`), skills / agents / commands
/ workflows / ui-views (own collections, own skills), or a capability that might already ship as a
module (`discovering-new-capabilities` first).

## quick reference

both meta verbs below are real but **absent from `dt help`**, whose usage text covers the generic
record verbs only. run them anyway.

| goal | how |
|---|---|
| new collection from a template | `npm run --silent dt -- collections add --name research-docs --template docs` |
| add a field | `npm run --silent dt -- <collection> add-field --name urgent --type boolean --default-value false` |
| templates available | `.dreamteamer/system/collection-templates/` (`docs` today) |
| make it live | `npm run compile` — **required**; both meta verbs print `⚠ .dreamteamer is stale` |
| see what breaks | `npm run check` |

both meta verbs write the **workspace module's** source and commit it themselves. `--type` is
sugar over JSON Schema (`string`/`text`, `markdown`, `boolean`, `number`, `integer`, `date`,
`datetime`, `enum` +`--options "a,b,c"`, `tags`, `reference` +`--target <collection>`, or a bare
collection name for a reference into it); `--required true` widens `required`.

## the descriptor is a record too — read its schema

anything the meta verbs can't express, you hand-author, and **the meta descriptor
`.dreamteamer/system/collections/collections.collection.yaml` IS the spec**: every key a
descriptor may carry (`storage`, `id`, `schema`, `extends`, `order`, `list_fields`, `icon`,
`group` — the last two are the studio nav's material-symbol icon and folder; ungrouped
collections list at the top of the nav) with its allowed values. `npm run --silent dt -- collections get <name>` shows a real, working one. don't
learn the shape from prose — read those two.

what neither of them tells you, because it's judgment:

- **`id.generate` takes creation-time values only** — `{{ created | date }}--{{ title | slug }}`,
  never a mutable field like `due` or `status`. `id.pattern` must accept everything the template
  can produce: note that non-latin titles (hebrew) slug to a deterministic short hash, so a
  `[a-z0-9-]` pattern still holds.
- **the `x-` keywords carry the domain semantics** — `x-reference` (target collection, or `"*"`
  for any) is what lets `check` and `rename` follow a field; `x-display` is the relation display
  template; `x-body` marks the single field that becomes the md body.

## extending a module's collection

to add fields to a collection another module owns, write a same-name descriptor declaring
`extends: <package-name>/<collection>` — compile merges `schema.properties` per-property, unions
`required`, and takes `storage`/`id` from the base. when **two** modules extend the same base
they're applied in module-discovery order (`modules/*`, alphabetical) and the last one wins on any
key both touch — so never rely on a collision between extenders; make the fields disjoint. real
example, `modules/hq3/system/collections/tasks.collection.yaml`:

```yaml
name: tasks
extends: '@dreamteamer/dreamteamer/tasks'
schema:
  properties:
    urgent: { type: boolean, default: false }
```

two same-name descriptors where neither declares `extends` is a compile error; so is an `extends`
value that doesn't name the actual base.

## registering an existing data folder

1. sample the files: derive `suffix`/`codec` from the filenames (`<id>.<suffix>.<ext>`) and the id
   `pattern` from the id shapes actually present.
2. collect frontmatter keys across files → `properties`; infer types from values. a string field
   with ≤10 distinct values, repeats and ≥80% fill is probably an `enum`; values shaped
   `<collection>/<id>` are `x-reference` fields. no frontmatter at all → `required: []` with a
   comment saying why.
3. **never edit the records to fit an inferred schema** — describe reality, compile, run check,
   then decide which violations are worth fixing in the data.

**evolving a schema:** edit the source, compile, run `check` to see which records now violate —
check reports, you decide. widening (new optional field, new enum value) is always safe;
narrowing (new required field, removed enum value) needs the data cleaned first.

## common mistakes

| mistake | reality |
|---|---|
| editing `.dreamteamer/system/collections/…` | that's the compiled runtime — gitignored, overwritten. edit the source. |
| forgetting `npm run compile` | the CLI, `check` and the harness all still see the old shape. |
| a mutable field in `id.generate` (`due`, `status`) | ids must never change. creation-time values only. |
| tightening `required` before cleaning the data | check floods with violations; widen first, migrate, then narrow. |
| a second same-name descriptor without `extends` | compile error by design — declare `extends: <pkg>/<collection>`. |
| a plain string field where a ref belongs | use `x-reference` so `check` and `rename` can follow it. |
| inventing a collection for a one-off extraction | prefer the nearest real collection; a collection is for things that recur. |
