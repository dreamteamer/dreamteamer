# collections — the mechanics of declaring shape

One descriptor file: `modules/<module>/collections/<name>.collection.yaml`. The descriptor
**describes reality** — you do not edit records to fit an inferred schema.

Two references divide this territory: the *judgment* — grain, relations, enums vs vocabularies,
what deserves to be a collection at all — lives in `data-modeling.md`; the **mechanics** live
here. You are here either authoring a descriptor or staring at a compile message, and the
reference is organized for both:

| the question | read |
|---|---|
| what compile actually does to my source | the pipeline |
| create or change shape with the CLI | the schema verbs |
| a brand-new module for a domain | declaring a module |
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
   `{{ id }}` — which is a smell, see `data-modeling.md` Part VII §31), and a `title` per field.
   Authored values always win; derivation never overwrites.
8. **Bytes dump** to `.dreamteamer/collections/<name>.collection.yaml`, with per-source hashes in
   the manifest — which is what lets `dt status` say precisely which source went stale.

Consequence: **read the compiled file to know what IS; edit the source to change it.** They
differ by design, and diffing them is often the fastest way to see what compile decided for you.

## the schema verbs — writes through a compile gate

The one sanctioned way to write schema without hand-editing. Every verb round-trips through a
**compile gate**, so a change that would not compile is rejected before it lands — and unlike a
record write, a schema verb **commits its source write itself**, because an uncompilable or
unpublished schema is not a state the workspace should sit in. The verbs and every flag live in
`dt help` under "schema verbs" — read that, not prose. What help cannot tell you:

- **The field verbs write the WORKSPACE module.** On a collection another module owns, `add-field`
  and `update-field` author an `extends:` overlay in the workspace module — which compiles only
  if the workspace module declares the owning module in `dreamteamer.dependencies` (the extends
  gate exempts nobody). `remove-field` has no overlay form at all — an overlay cannot remove an
  inherited field, so it refuses a module-shipped field by name. So on a module-owned collection:
  declare the dependency and let add/update write the overlay (the change stays workspace-local),
  or **edit the owning module's descriptor by hand** and compile (the change ships with the
  module) — the only exit for a removal. Pick by who should own the field — `data-modeling.md`
  Part III.
- **`--type <collection>` beats the type sugar, always.** A type that names a collection in the
  runtime is a reference to it, whatever `string`/`enum`/`date`/`tags`/… would otherwise mean — so
  in a workspace that ships a `tags` collection, `--type tags` points at it and the relation flags
  work on it. Only a stated `--type` resolves this way; omitting it still means a plain string.
- `remove-field` on a populated field **clears the values in the same write and reports the
  count** — a leftover key would make every later write to those records fail as unknown. It also
  prunes the field out of **the same descriptor's `list_fields` and `sort_field`** (that is the
  field's own presentation, and a dangling `sort_field` is a compile error), and **warns, by id,**
  about any ui-view whose `options.columns` still names it — a different source, so it is named
  rather than edited.
- **`add-field` inserts before the `x-body` field**, on the same rule as a `templates:` merge
  below: property order is form order, and a record's body belongs last. `update-field` never
  reorders — an existing field keeps the place its author gave it.
- **`schema rename-collection <old> <new>`** moves the descriptor **in the module that ships it**
  (its guard is against writes an `npm install` would erase, not against modules), plus the
  records, the filenames and every inbound reference — `x-reference` targets in other descriptors
  and ui-views included — in ONE commit. It refuses: a runtime source, an **overlaid** collection
  (the overlay's `extends` names the old id), a collection shipped from `node_modules/`, a taken
  name, and an undeclared target namespace; a refusal leaves nothing half-moved. It deliberately
  does NOT overrule two authored choices: a hand-set `storage.path` (records stay put, and it
  says so) and a `storage.suffix` that is not the singular of the old name.
- An **empty value removes** in dotted `set-view` writes just as it does in `dt set` — so a
  setting whose meaningful value IS empty (`options.sort: ''`, see `ui-views.md`) must be
  hand-written in the source file; the CLI cannot express it.

## declaring a module

A module is a folder under `modules/<name>/` whose `package.json` carries **a `dreamteamer` key —
`"dreamteamer": {}` is enough** — plus the kind folders it ships (`collections/`, `skills/`, …).
Without that key the folder is **silently ignored** by discovery; with an unknown kind folder
inside, compile errors. The module's `name` in package.json is its identity in `owner`,
`extends:` and dependency declarations. What belongs in a module vs the workspace module is
judgment — `data-modeling.md` Part III §8.

## the workspace manifest — the `dreamteamer` block in `package.json`

The workspace-level switches the engine reads live in one place. The keys, and where each is
explained:

| key | what it holds | detail |
|---|---|---|
| `workspace-module` | which module under `modules/` is the workspace's own | SKILL.md, the contract |
| `data-path` | where records live, workspace-relative (default `data`) | — |
| `namespaces` | the declared namespace prefixes | namespaces, below |
| `vars` | the `.env` keys records may reference as `${env:KEY}` | records.md, templates |
| `auto-commit` | whether a record write also commits (default off) | records.md, committing |
| `harnesses` | which coding-agent adapters compile writes (`claude-code`, `codex`, …) | — |
| `git-modules` | the lockfile map `dt install` restores | — |
| `disable` | identity entities to drop from the compile, as `<module>/<entity>` | — |

A MODULE's own `package.json` carries the `dreamteamer` key that makes it discoverable (declaring
a module, above) plus `dreamteamer.dependencies` / `peerDependencies` when it reaches across the
module graph (the reference contract, below).

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
- ⚠ **No collection may store records inside another's folder** — a namespace folder cannot
  itself be a collection root. Compile refuses it, because the outer collection would index the
  inner one's records as its own.

## `templates:` — a live shared field set

```yaml
name: meetings
templates: [collection-templates/provenance]   # merged at compile, every time
```

- **`templates:` is not `extends:`.** `extends: <module>/<collection>` means "this descriptor
  *overlays* another module's collection of the same name". `templates:` pulls in a field set and
  says nothing about module layering. A descriptor may use both.
- **Precedence is template < base < overlay** — a descriptor always wins on a key it declares, so
  a collection can tighten a templated field (add an enum, change a default) without touching the
  template.
- **The template is a declared SOURCE of every consumer**, so editing it marks them stale and
  `dt status` names them. Without that, the edit would apply to nothing and warn about nothing.
- **Template properties insert before the `x-body` field** — property order is form order, and a
  record's body belongs last. Template `required` entries union in; other template keys apply
  only where the descriptor is silent.
- ⚠ **A `templates:` ref must resolve inside the module that ships the descriptor**, or that
  module cannot be installed or copied on its own. This is the single most expensive mistake in
  the project's history: an extracted module whose every descriptor referenced a template living
  in the *consuming* workspace could not compile into a bare workspace at all, and nobody noticed
  for months. A collection-template id is an *identity* entity, so two modules cannot both ship
  `provenance` — scope the id per module (`crm-provenance`).
- `--template X` at creation copies the fields in once. `templates:` is the live version; prefer
  it for anything you will want to change in one place later.

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

- **An overlay must declare the base's module in `dreamteamer.dependencies`** — `extends` is the
  hardest dependency there is (the overlay does not compile at all without its base), so compile
  refuses the undeclared case. The workspace module gets **no exemption here** (unlike the
  mirror-stamp and wildcard gates, which do exempt it) — this is exactly the refusal you meet
  when a field verb targets a module-owned collection (the schema verbs, above).
- ⚠ **An overlay can add fields but cannot remove an inherited one.** If the shape is wrong for
  the module rather than just for this workspace, fix the base.

## the reference contract — `x-reference` across the module graph

Every `x-reference` target must be one of: a **core** collection (the entity kinds plus `repos`)
· a collection **owned by this module** (or a module contributing to this descriptor) · owned by
a module named in **`dreamteamer.dependencies`** · or named in **`dreamteamer.peerDependencies`**
as a collection. Anything else fails compile, with the fix in the message.

The two declaration kinds are different on purpose. `dependencies` names MODULES, is hard (the
target must be installed), and must be acyclic — compile prints the ring when it isn't.
`peerDependencies` names COLLECTIONS and exists precisely for the ring case: two modules that
each reference a concept the other owns would be an unbreakable cycle as module deps, and are two
independent peer declarations instead. A peer that no installed module provides is recorded on
the compiled descriptor as `unresolved_peers`, so `check` can excuse its dangling references
without learning what a module is.

`x-reference: '*'` (the open-world evidence field) is warned about outside the workspace module —
an unverifiable cross-module surface — and tolerated inside it, because the workspace is the
orchestrating parent. A cross-module `x-inverse` needs the dependency declared too, since it
stamps a field onto the other module's collection.

## registering an existing data folder

1. Sample the files: derive `suffix`/`codec` from the filenames (`<id>.<suffix>.<ext>`) and the
   id `pattern` from the id shapes actually present.
2. Collect frontmatter keys across files → `properties`; infer types from values. Values shaped
   `<collection>/<id>` are `x-reference` fields. No frontmatter at all → `required: []` with a
   comment saying why.
3. Point `storage.path` at the folder — an authored path always wins over the derived default;
   this is the first-class case it exists for.
4. **Never edit the records to fit an inferred schema.** Describe reality, compile, run `check`,
   then decide which violations are worth fixing in the data.

## evolving a schema

Widening (a new optional field, a new enum value) is always safe; narrowing (a new required
field, a removed enum value) needs the data cleaned FIRST — measure, clean, *then* narrow, or
every later `check` drowns in the flood. The judgment lives in `data-modeling.md` Part IX; the
mechanical fact that lives here: **there is no `dt migrate`.** A record-based migration mechanism
shipped once and was removed having never been used — every real schema change went around it as
a **one-shot script you write, run once and commit with the records it rewrote**. Say in the
commit message what it did; that message is the only ledger.

## the message catalog — what compile is telling you

Compile fails closed and names its reasons; this is the translation table for the ones a
collection author actually meets. (⚠ = warning: it compiled, and you should still act.)

| the message says | it means | the move |
|---|---|---|
| `name collision on <kind> "<id>"` | two modules ship the same identity entity — never merged or shadowed | rename yours, or `dreamteamer.disable` one |
| `every descriptor declares 'extends' — no base found` | an overlay whose base is not installed | install or name the base |
| `extends "…" does not name the base` | the value must be `<module>/<collection>` of the actual base | fix the ref |
| `… does not declare '<module>' in dreamteamer.dependencies` | the extends gate — including a field verb's auto-overlay on a module-owned collection | declare the dependency, or edit the owning module's descriptor instead |
| `has folder(s) that are not a known kind` | a typo'd kind, or a kind the engine dropped | fix the name, or declare `dreamteamer.ignore` |
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

`check` has its own recurring messages, worth the same translation:

| check reports | it means | the move |
|---|---|---|
| `<field>: stale` on a mirror | the generated mirror fell behind its owner — usually a hand-edited mirror | `dt relations rebuild <collection>` |
| a dangling reference | the target id does not resolve — a deleted or hand-renamed record, or a typo | fix the ref, restore the target, or `dt rename` properly |
| an `x-unique` collision, both claimants named | two records claim the same one-per-subject reference | decide which is real; retarget the other |
| a FLOOD of enum/required violations right after a schema change | the schema narrowed before the data was cleaned | widen back, clean, then narrow (evolving, above) |

*(one failure has no message: a module folder whose `package.json` lacks a `dreamteamer` key is
silently not discovered — see declaring a module.)*

## common mistakes

| mistake | reality |
|---|---|
| editing the compiled descriptor to change shape | `.dreamteamer/` is generated — edit the module source and compile |
| tightening `required` before cleaning the data | check floods; widen, rewrite the data, then narrow |
| a second same-name descriptor without `extends` | compile error by design |
| a plain string where a ref belongs | use `x-reference` so `check` and `rename` can follow it |
| a `templates:` ref pointing at another module | that module can no longer be copied or installed alone |
| a field verb aimed at a module-owned collection, retried verbatim | add/update write a workspace overlay behind a dependency gate — declare the dependency or edit the owning module; remove-field refuses outright (edit the module) |
| authoring `storage.path` under an entity-kind name | it compiles as a runtime collection and becomes unwritable |
| hand-editing schema when a schema verb could express it | the verbs are compile-gated and commit their write; a hand edit can land uncompilable and sit unpublished |
| ignoring a ⚠ because compile said ✔ | every warning above is a defect with a deferred bill |
