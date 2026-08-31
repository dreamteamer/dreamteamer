# collections — the mechanics of declaring shape

One descriptor file: `modules/<module>/collections/<name>.collection.yaml`. The descriptor
**describes reality** — you do not edit records to fit an inferred schema.

Two references divide this territory: the *judgment* — grain, relations, enums vs vocabularies,
what deserves to be a collection at all — lives in `data-modeling.md`; the **mechanics** live here.
You are here either authoring a descriptor or staring at a compile message, and the reference is
organized for both:

| the question | read |
|---|---|
| what compile actually does to my source | the pipeline |
| create or change shape with the CLI | the meta verbs |
| a prefix / a folder per domain | namespaces |
| the same field set on several collections | `templates:` |
| adding fields to another module's collection | `extends:` |
| a reference into another module | the reference contract |
| a data folder that already exists | registering an existing folder |
| changing shape with records present | evolving a schema |
| what a compile message means | the message catalog |

## the pipeline — what compile does to a descriptor

The compiled descriptor is not a copy of your source; it is the source **resolved**. Knowing the
order explains most "why does the compiled file say that" questions:

1. **`templates:` merge in** — fields inserted *before* the `x-body` property, descriptor winning
   on any key it declares.
2. **`extends:` overlays merge onto the base** — properties per-property, `required` unioned,
   other keys extender-wins.
3. **Storage resolves** — `storage.path` defaults to `data/<name>` (namespace-nested);
   `storage.base` is derived (`runtime` iff the path IS one of the entity-kind folders — never
   author that); an `owns-data` module's path gets prefixed with the module root and its git repo
   recorded as `storage.repo`.
4. **`codec: file` collections get their derived schema** (`ext`, `bytes`) — an authored schema
   there is warned about and replaced; the bytes are the whole record.
5. **Validation, per collection** — still inside the merge loop, before any relation exists: the
   merged schema must itself compile as JSON Schema; `id.pattern` must be a valid regex;
   `sort_field` must name a real field; every `x-reference` target is checked against the module
   graph (below); at most one `x-body`.
6. **Relations materialize** — `x-inverse-of` folds onto the owner, mirrors are stamped
   (`readOnly`, `x-inverse-of`, `uniqueItems` on arrays), cardinality closes, and the
   relation-specific refusals fire here. The semantics are `data-modeling.md` Part VI; the point
   here is that this runs across ALL descriptors at once, because a relation spans two files.
7. **Labels derive** — after relations, so generated mirrors get titles too: `title` (title-cased
   bare name, namespace stripped), `title_template` (the `title`/`name`/`subject` probe, else
   `{{ id }}` — which is a smell, see Part VII §31), and a `title` per field. Authored values
   always win; derivation never overwrites.
8. **Bytes dump** to `.dreamteamer/collections/<name>.collection.yaml`, with per-source hashes in
   the manifest — which is what lets `dt status` say precisely which source went stale.

Consequence: **read the compiled file to know what IS; edit the source to change it.** They differ
by design, and diffing them is often the fastest way to see what compile decided for you.

## the meta verbs — schema writes through a compile gate

The one sanctioned way to write schema without hand-editing: each verb round-trips through a
**compile gate**, so a change that would not compile is rejected before it lands on disk. They are
all listed in `dt help` under "schema verbs" — read that for the full flag surface; the table below
is the map.

| goal | how |
|---|---|
| new collection from a template | `dt schema add-collection --name research-docs --template docs` |
| move one into a namespace | `dt schema rename-collection doctors health/doctors` (or `doctors --namespace health`) |
| templateless | `dt schema add-collection --name <n>` — emits a minimal compilable schema |
| add a field | `dt schema add-field <collection> --name urgent --type boolean --default-value false` |
| mark the prose field | `dt schema add-field <collection> --name notes --type markdown --body` |
| change / drop a field | `dt schema update-field <collection> …` · `schema remove-field <collection> --name <f>` |
| delete a collection | `dt schema rm-collection <name>` |
| what templates exist | `.dreamteamer/collection-templates/` |

`--type` is sugar over JSON Schema: `string`/`text`, `markdown`, `boolean`, `number`, `integer`,
`date`, `datetime`, `enum` (+`--options "a,b,c"`), `tags`, `reference` (+`--target <collection>`),
or a bare collection name for a reference into it. `--required true` widens `required`. `--body`
marks the ONE field a `codec: md` record's prose lands in — it must be a text type, and a second
one is a compile error (`--body false` clears it).

Two semantics worth knowing because their absence used to corrupt data: `update-field` carries the
**whole property** (changing a description no longer strips an enum or a format), and
`remove-field` on a populated field **clears the values in the same write and reports the count** —
a leftover key would make every later write to those records fail as an unknown field.

⚠ **The field verbs write the WORKSPACE module's descriptor only.** To change a field on a
collection another module owns, either edit that module's descriptor by hand or add an `extends:`
overlay — the verbs refuse a module-shipped field by name ("the workspace can only OVERRIDE
fields"). `rename-collection` is the exception: it renames the descriptor **in the module that
ships it**, because its guard is against writes an `npm install` would erase, not against modules.

**`dt schema rename-collection <old> <new>`** moves the descriptor, the records, the record
filenames and every inbound reference in ONE commit — including `x-reference` targets in other
descriptors and any ui-view pointing at it. `<old> --namespace <ns>` is sugar for moving it into a
namespace under the same bare name. It refuses a compiled (runtime) source, an **overlaid**
collection (the overlay's `extends` names the old id — a second migration it will not half-do), a
collection shipped from `node_modules/` (the write would be erased), a taken name, and an
undeclared target namespace; a refusal leaves nothing half-moved. Two things it
deliberately does NOT overrule, because both are authored choices: a `storage.path` you set by hand
(the records stay put, and it says so) and a `storage.suffix` that is not the singular of the old
name.

## namespaces — scoping a collection under a folder

A collection name may carry a slash-delimited namespace, and it becomes real directory nesting:

| declare in the workspace `package.json` | create it | lands in | referenced as |
|---|---|---|---|
| `"namespaces": ["health"]` | `dt schema add-collection --namespace health --name doctors` | `data/health/doctors/` | `health/doctors/dana-levi` |

- **The default namespace is the empty prefix.** `tasks` stays `data/tasks/` and `tasks/kickoff`,
  so common entities need no prefix and adopting namespaces migrates nothing. `default` is
  RESERVED — there is never a second spelling for one collection.
- ⚠ **The namespace MUST be declared before the collection compiles.** An id is also a slash path
  (`meetings/2026/07/kickoff`), so `a/b/c` is ambiguous without the declared set; an undeclared
  prefix is a compile error rather than a reference that silently names a different collection.
- **Namespaces are declared by the WORKSPACE only, never by a module** — a module that could
  declare one could rename where another module's records live.
- `--namespace health --name doctors` and `--name health/doctors` are the same thing. The
  descriptor lands at `collections/health/doctors.collection.yaml` — `collections/` is enumerated
  recursively, so the source tree mirrors the runtime — and the `suffix` comes off the bare name
  (`<id>.doctor.md`).
- `x-reference: health/doctors`, `disable: "<module>/health/doctors"` and every record verb take
  the QUALIFIED name — it is the collection's identity everywhere. Only its *label* drops the
  prefix: the derived `title` comes from the bare name, because every surface already draws the
  namespace as a folder around it.
- Nested namespaces work (`work/clients`); the longest declared prefix wins.
- ⚠ **No collection may store records inside another's folder** — a namespace folder cannot itself
  be a collection root. Compile refuses it, because the outer collection would index the inner
  one's records as its own.

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
  record's body belongs last. Template `required` entries union in; other template keys apply only
  where the descriptor is silent.
- ⚠ **A `templates:` ref must resolve inside the module that ships the descriptor**, or that module
  cannot be installed or copied on its own. This is the single most expensive mistake in the
  project's history: an extracted module whose every descriptor referenced a template living in the
  *consuming* workspace could not compile into a bare workspace at all, and nobody noticed for
  months. A collection-template id is an *identity* entity, so two modules cannot both ship
  `provenance` — scope the id per module (`crm-provenance`).
- `--template X` at creation copies the fields in once. `templates:` is the live version; prefer it
  for anything you will want to change in one place later.

## `extends:` — overlaying another module's collection

```yaml
name: tasks
extends: '@dreamteamer/dreamteamer/tasks'
schema:
  properties:
    urgent: { type: boolean, default: false }
```

Compile merges `schema.properties` per-property, unions `required`, and takes `storage`/`id` from
the base unless the overlay explicitly declares them. Two modules extending the same base are
applied in module-discovery order and the last wins on any shared key — so keep extenders
**disjoint** and never rely on the collision. Two same-name descriptors where neither declares
`extends` is a compile error; so is an `extends` value that does not name the actual base.

Two gates around it:

- **An overlay in another module must declare the base's module in `dreamteamer.dependencies`** —
  `extends` is the hardest dependency there is (the overlay does not compile at all without its
  base), so compile refuses the undeclared case. The workspace module gets **no exemption here**
  (unlike the mirror-stamp and wildcard gates, which do exempt it): even the workspace declares
  the module it overlays.
- ⚠ **An overlay can add fields but cannot remove an inherited one.** If the shape is wrong for the
  module rather than just for this workspace, fix the base.

## the reference contract — `x-reference` across the module graph

Every `x-reference` target must be one of: a **core** collection (the entity kinds plus `repos`) ·
a collection **owned by this module** (or a module contributing to this descriptor) · owned by a
module named in **`dreamteamer.dependencies`** · or named in **`dreamteamer.peerDependencies`** as
a collection. Anything else fails compile, with the fix in the message.

The two declaration kinds are different on purpose. `dependencies` names MODULES, is hard (the
target must be installed), and must be acyclic — compile prints the ring when it isn't.
`peerDependencies` names COLLECTIONS and exists precisely for the ring case: two modules that each
reference a concept the other owns (crm needs `products`, rnd needs `contacts`) would be an
unbreakable cycle as module deps, and are two independent peer declarations instead. A peer that no
installed module provides is recorded on the compiled descriptor as `unresolved_peers`, so `check`
can excuse its dangling references without learning what a module is.

`x-reference: '*'` (the open-world evidence field) is warned about outside the workspace module —
an unverifiable cross-module surface — and tolerated inside it, because the workspace is the
orchestrating parent. A cross-module `x-inverse` needs the dependency declared too, since it stamps
a field onto the other module's collection (`data-modeling.md` Part VI §27).

## registering an existing data folder

1. Sample the files: derive `suffix`/`codec` from the filenames (`<id>.<suffix>.<ext>`) and the id
   `pattern` from the id shapes actually present.
2. Collect frontmatter keys across files → `properties`; infer types from values. Values shaped
   `<collection>/<id>` are `x-reference` fields. No frontmatter at all → `required: []` with a
   comment saying why.
3. Point `storage.path` at the folder — an authored path always wins over the derived default;
   this is the first-class case it exists for.
4. **Never edit the records to fit an inferred schema.** Describe reality, compile, run `check`,
   then decide which violations are worth fixing in the data.

## evolving a schema

Widening (a new optional field, a new enum value) is always safe; narrowing (a new required field,
a removed enum value) needs the data cleaned first — measure, clean, *then* narrow, or every later
`check` drowns in the flood (`data-modeling.md` Part IX). A shape change across many existing
records is a **one-shot script you write, run once and commit with the records it rewrote** — there
is no `dt migrate`. A record-based migration mechanism shipped in July 2026 and was removed on
2026-07-31 having never once been used: every real schema change in this project's history went
around it as a script. If you write one, say in the commit message what it did, because that
message is the only ledger.

## the message catalog — what compile is telling you

Compile fails closed and names its reasons; this is the translation table for the ones a collection
author actually meets. (⚠ = warning: it compiled, and you should still act.)

| the message says | it means | the move |
|---|---|---|
| `name collision on <kind> "<id>"` | two modules ship the same identity entity — never merged or shadowed | rename yours, or `dreamteamer.disable` one |
| `every descriptor declares 'extends' — no base found` | an overlay whose base is not installed | install or name the base |
| `extends "…" does not name the base` | the value must be `<module>/<collection>` of the actual base | fix the ref |
| `has folder(s) that are not a known kind` | a typo'd kind, or a kind the engine dropped — both used to compile ✔ and contribute nothing | fix the name, or declare `dreamteamer.ignore` |
| ⚠ `both <kind>/ and system/<kind>/ exist` | a half-moved module — the flat copy wins, the nested one is NOT compiled | finish the move |
| `schema is not a valid JSON Schema` | a malformed property — usually a string where an object belongs | fix the property it names |
| `id.pattern is not a valid regular expression` | the typo would otherwise detonate inside a write | fix the pattern |
| `sort_field "…" is not a field of its schema` | dragging would silently write to a field no reader sorts by | point it at a real field |
| `field "…" uses x-display` | renamed keyword | delete it (a reference inherits the target's `title_template`) or use `x-title-template` |
| `N fields declare x-body` | a record has ONE body — the text after the frontmatter | keep one |
| `references "X", which … neither owns nor declares` | the reference contract | add the dependency or the peer, as the message says |
| `cyclic module dependencies: a → b → a` | concept-level links declared as module deps | the collection belongs in `peerDependencies` |
| relation refusals (`stamps a mirror onto…`, `declared on both sides…`) | the relation rules | `data-modeling.md` Part VI |
| ⚠ `x-unique on "f" is inert` | a relation keyword with no relation — nothing enforces it | declare the inverse, or drop it |
| ⚠ `collection … has no description` | it renders as a bare name in the orientation block every session loads | write the sentence (`data-modeling.md` §18) |
| ⚠ `module "…" contributed no recognised sources` | its folders match no kind and it ships no UI bundle | usually a layout or naming mistake |
| ⚠ `module X: <channel> copy shadows <channel> copy` | the same module delivered twice — the more local wins (npm-link semantics) | intended for dev; otherwise remove one |

## common mistakes

| mistake | reality |
|---|---|
| editing the compiled descriptor to change shape | `.dreamteamer/` is generated — edit the module source and compile |
| tightening `required` before cleaning the data | check floods; widen, rewrite the data, then narrow |
| a second same-name descriptor without `extends` | compile error by design |
| a plain string where a ref belongs | use `x-reference` so `check` and `rename` can follow it |
| a `templates:` ref pointing at another module | that module can no longer be copied or installed alone |
| authoring `storage.path` under an entity-kind name | it compiles as a runtime collection and becomes unwritable |
| hand-editing schema when a meta verb exists | the verbs are compile-gated; a hand edit can land uncompilable |
| ignoring a ⚠ because compile said ✔ | every warning above is a defect with a deferred bill |
