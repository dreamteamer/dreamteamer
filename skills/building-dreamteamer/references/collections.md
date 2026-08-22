# collections

One descriptor file: `modules/<module>/collections/<name>.collection.yaml`. The descriptor
**describes reality** — you do not edit records to fit an inferred schema.

## the meta verbs (real, absent from `dt help`)

| goal | how |
|---|---|
| new collection from a template | `dt schema add-collection --name research-docs --template docs` |
| move one into a namespace | `dt schema rename-collection doctors health/doctors` (or `doctors --namespace health`) |
| templateless | `dt schema add-collection --name <n>` — emits a minimal compilable schema |
| add a field | `dt schema add-field <collection> --name urgent --type boolean --default-value false` |
| change / drop a field | `dt schema update-field <collection> …` · `schema remove-field <collection> --name <f>` |
| delete a collection | `dt schema rm-collection <name>` |
| what templates exist | `.dreamteamer/collection-templates/` |

`--type` is sugar over JSON Schema: `string`/`text`, `markdown`, `boolean`, `number`, `integer`,
`date`, `datetime`, `enum` (+`--options "a,b,c"`), `tags`, `reference` (+`--target <collection>`),
or a bare collection name for a reference into it. `--required true` widens `required`.

⚠ **The meta verbs write the WORKSPACE module only.** To change a field on a collection another
module owns, either edit that module's descriptor by hand or add an `extends:` overlay.
**`dt schema rename-collection <old> <new>`** moves the descriptor, the records, the record filenames and
every inbound reference in ONE commit — including `x-reference` targets in other descriptors and any
ui-view pointing at it. `<old> --namespace <ns>` is sugar for moving it into a namespace under the same
bare name. It refuses a compiled source, a module-owned collection, a taken name, and an undeclared
target namespace; a refusal leaves nothing half-moved. Two things it deliberately does NOT overrule,
because both are authored choices: a `storage.path` you set by hand (the records stay put, and it says
so) and a `storage.suffix` that is not the singular of the old name.

## namespaces — scoping a collection under a folder

A collection name may carry a slash-delimited namespace, and it becomes real directory nesting:

| declare in the workspace `package.json` | create it | lands in | referenced as |
|---|---|---|---|
| `"namespaces": ["health"]` | `dt schema add-collection --namespace health --name doctors` | `data/health/doctors/` | `health/doctors/dana-levi` |

- **The default namespace is the empty prefix.** `tasks` stays `data/tasks/` and `tasks/kickoff`, so
  common entities need no prefix and adopting namespaces migrates nothing. `default` is RESERVED —
  there is never a second spelling for one collection.
- ⚠ **The namespace MUST be declared before the collection compiles.** An id is also a slash path
  (`meetings/2026/07/kickoff`), so `a/b/c` is ambiguous without the declared set; an undeclared prefix
  is a compile error rather than a reference that silently names a different collection.
- `--namespace health --name doctors` and `--name health/doctors` are the same thing. The descriptor
  lands at `collections/health/doctors.collection.yaml`, mirroring the runtime; the `suffix` comes off
  the bare name (`<id>.doctor.md`).
- `x-reference: health/doctors`, `disable: "<module>/health/doctors"` and every record verb all take the
  QUALIFIED name — it is the collection's identity everywhere.
- Nested namespaces work (`work/clients`), longest declared prefix wins.
- ⚠ **No collection may store records inside another's folder** — a namespace folder cannot itself be a
  collection root. compile refuses it, because the outer collection would index the inner one's records
  as its own.

## `templates:` — a live shared field set

```yaml
name: meetings
templates: [collection-templates/provenance]   # merged at compile, every time
```

- **`templates:` is not `extends:`.** `extends: <module>/<collection>` means "this descriptor
  *overlays* another module's collection of the same name". `templates:` pulls in a field set and
  says nothing about module layering. A descriptor may use both.
- **Precedence is template < base < overlay** — a descriptor always wins on a key it declares, so a
  collection can tighten a templated field (add an enum, change a default) without touching the
  template.
- **The template is a declared SOURCE of every consumer**, so editing it marks them stale and
  `dt status` names them. Without that, the edit would apply to nothing and warn about nothing.
- **Template properties insert before the `x-body` field** — property order is form order, and a
  record's body belongs last.
- ⚠ **A `templates:` ref must resolve inside the module that ships the descriptor**, or that module
  cannot be installed or copied on its own. This is the single most expensive mistake in the
  project's history: an extracted module whose every descriptor referenced a template living in the
  *consuming* workspace could not compile into a bare workspace at all, and nobody noticed for
  months. A collection-template id is an *identity* entity, so two modules cannot both ship
  `provenance` — scope the id per module (`crm-provenance`).
- `--template X` at creation copies the fields in once. `templates:` is the live version; prefer it
  for anything you will want to change in one place later.

## judgment the descriptor can't tell you

- **`id.generate` takes creation-time values only** — `{{ created | date }}--{{ name | slug }}`,
  never a mutable field (`due`, `status`, and note `created` itself is the moment the record is
  WRITTEN, so a back-dated import files under the import month; derive from the domain's own date
  field instead). `id.pattern` must accept everything the template can produce — non-latin titles
  slug to a deterministic short hash, so `[a-z0-9-]` still holds.
- **The `x-` keywords carry the domain semantics.** `x-reference` (a target collection, or `"*"` for
  any) is what lets `check` and `rename` follow a field. `x-body` marks the single field that becomes
  the md body. `x-inverse` declares a two-way link and makes `check` enforce both directions.
  `x-title-template` overrides how a VALUE of that field is labelled — rarely needed, because a
  reference already inherits its TARGET collection's `title_template`; author it there instead, once,
  rather than on every field pointing at it.
- **Do not enum a field after the fact.** Enumerating a vocabulary the records already violate makes
  `check` fail on every pre-existing value. `dt values <collection> <field>` derives the real
  vocabulary from the data — a filter dropdown gets it for free without locking the set.
- **`icon` / `group`** are the studio nav's material-symbol icon and folder; ungrouped collections
  list at the top. `list_fields` is the SEED a module ships, not a competing source of truth — a
  ui-view's `columns` REPLACES it.

## extending another module's collection

```yaml
name: tasks
extends: '@dreamteamer/dreamteamer/tasks'
schema:
  properties:
    urgent: { type: boolean, default: false }
```

Compile merges `schema.properties` per-property, unions `required`, and takes `storage`/`id` from
the base. Two modules extending the same base are applied in module-discovery order and the last
wins on any shared key — so keep extenders **disjoint** and never rely on the collision. Two
same-name descriptors where neither declares `extends` is a compile error; so is an `extends` value
that does not name the actual base.

⚠ **An overlay can add fields but cannot remove an inherited one.** If the shape is wrong for the
module rather than just for this workspace, fix the base.

## registering an existing data folder

1. Sample the files: derive `suffix`/`codec` from the filenames (`<id>.<suffix>.<ext>`) and the id
   `pattern` from the id shapes actually present.
2. Collect frontmatter keys across files → `properties`; infer types from values. A string field
   with ≤10 distinct values, repeats and ≥80% fill is probably an `enum` — but see the warning
   above. Values shaped `<collection>/<id>` are `x-reference` fields. No frontmatter at all →
   `required: []` with a comment saying why.
3. **Never edit the records to fit an inferred schema.** Describe reality, compile, run `check`,
   then decide which violations are worth fixing in the data.

**Evolving a schema:** widening (a new optional field, a new enum value) is always safe; narrowing
(a new required field, a removed enum value) needs the data cleaned first. A shape change across many existing
records is a **one-shot script you write, run once and commit with the records it rewrote** — there is
no `dt migrate`. A record-based migration mechanism shipped in July 2026 and was removed on 2026-07-31
having never once been used: every real schema change in this project's history went around it as a
script. If you write one, say in the commit message what it did, because that message is the only
ledger.

## common mistakes

| mistake | reality |
|---|---|
| a mutable field in `id.generate` (`due`, `status`) | ids must never change |
| `id.generate` from `created` for imported records | `created` is when the record was written, not when the thing happened |
| tightening `required` before cleaning the data | check floods; widen, rewrite the data, then narrow |
| a second same-name descriptor without `extends` | compile error by design |
| a plain string where a ref belongs | use `x-reference` so `check` and `rename` can follow it |
| a `templates:` ref pointing at another module | that module can no longer be copied or installed alone |
| inventing a collection for a one-off extraction | a collection is for things that recur; prefer the nearest real one |
