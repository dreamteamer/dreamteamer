# collections — the mechanics of declaring shape

One descriptor file: `modules/<module>/collections/<name>.collection.yaml`. The descriptor
**describes reality** — you do not edit records to fit an inferred schema.

Two references divide this territory: the *judgment* — grain, relations, enums vs vocabularies,
what deserves to be a collection at all — lives in `data-modeling.md`; the **mechanics** live
here. The meta-descriptor `.dreamteamer/collections/collections.collection.yaml` states every key
in one line each; this reference says how they behave:

| the question | read |
|---|---|
| what a descriptor holds — keys, types, ids, display | the descriptor · fields · ids and templates · display |
| what compile does to my source, and what a message means | the pipeline · the message catalog |
| create or change shape with the CLI | the system and field verbs |
| a module, the `package.json` block, a namespace | declaring a module · the workspace manifest · namespaces |
| records inside their parent's folder | relationship-based storage |
| shared fields, another module's collection, a cross-module reference | mixins · overlays · the reference contract |
| a data folder that already exists, or shape changing under records | registering an existing folder · evolving a schema |

## the descriptor

```yaml
# modules/default/collections/people.collection.yaml
name: people
singular: person                 # the inflector leaves `people` as it is; `dt add person …` reads better
description: A person this workspace deals with — never the organisation, which is `companies`.
use_when: a person is named in a meeting, an email or a document — find or create them here first
storage:
  suffix: person                 # <id>.person.md
fields:
  name:
    type: string
    required: true
    description: Full name, as they write it.
  email:
    type: email
    unique: true
    description: Where to write to them. Unique — two records with one address are one person.
  notes:
    type: markdown
    body: true
    description: Anything worth knowing, as prose.
```

The top-level keys, closed (any other is a compile error naming the list):

| key | contract |
|---|---|
| `name` | the id; equals the filename; carries the namespace (`health/visits`) |
| `title` | the human label; default the title-cased bare name |
| `singular` | the word the CLI also accepts (`dt add person`); default the inflected bare name, namespace kept. Compile warns when the inflector cannot singularise the name, and refuses two collections answering to one word |
| `record_title` | how one record is labelled wherever it is referenced — a template; default the first of `title` · `name` · `subject`, else `{{ id }}`. Its first token must be a `string` or `markdown` field: it is what `dt add <collection> "<title>"` fills |
| `description` · `use_when` | what one record IS (naming the neighbour it is not) · the situations that bring a session here. Both feed the orientation block (`data-modeling.md` §18) |
| `internal` | workspace plumbing, left out of the domain listing — the engine's collections and the workspace module's only |
| `sensitive` | records never leave through an export; the same key on a field keeps one field back |
| `storage` | `path` (default `data/<name>`) · `format: md \| yaml \| json \| binary` (default `md`) · `shape: file \| folder` · `entry` (folder shape: the file that IS the record) · `suffix` (default the inflected bare name — an authored `singular` does not change it) · `under` (below) · `max_bytes` · `accept` (binary only) |
| `ids` | `from` and `pattern` — ids and templates, below |
| `mixins` · `overlay` | below |
| `fields` | the fields, in form order. **Required to be present** — it is what marks a descriptor; a `format: binary` collection writes `fields: {}` |
| `constraints` | a list of JSON Schema combinators for a rule across fields. Every property named must be a field, and an `if` must name `required` or it passes vacuously on a record lacking the field |
| `display` | nav · list · record · form, below |

## fields

| `type` | stores | notes |
|---|---|---|
| `string` · `markdown` | text | `markdown` with `body: true` is the record's prose, one per collection, kept last |
| `boolean` · `integer` · `number` | as named | |
| `date` · `datetime` | `2026-10-02` · an instant with its offset | the CLI stamps the local offset on `"2026-10-02 12:00"` |
| `url` · `email` | text, format-checked | |
| `<collection>` | a reference, `<collection>/<id>` | the foreign key |
| `[a, b]` | a reference to one of several | the stored prefix disambiguates |
| `reference` | a reference to any collection | existence checked only; no mirror; warns outside the workspace module |
| `object` | a nested map, with `fields:` | with `many: true`, rows labelled by `item_title` |
| `map` | key → value, typed by `values:` | `values` omitted: an open map |
| `position` | the manual-order key `dt reorder` writes | one per collection, never `many` |

`many: true` makes a list of any type but `position`; constraints on a `many` field (`pattern`, `minimum`,
`maxLength`…) apply to each item. A collection may not be named after a type.

The field keys, closed — the order a field is best written in:

| key | contract |
|---|---|
| `type` · `title` | the type above · the label, default the title-cased name |
| `required` · `many` · `default` | as named; a default is filled in at `dt add` |
| `enum` | a list, or a map of value → `{ label, description, icon, color, background }`; on `type: string` only. Map order is band order. A value that is not kebab-case warns (`dt rename-value` renames one) |
| `unique` | no two records hold the same value, on any scalar field — enforced at write and by `check`, both claimants named; absent never claims |
| `mirror_of` | this field is the generated, read-only mirror of the named field on the `type` collection — the one relation spelling (`data-modeling.md` Part VI) |
| `on_delete` | `restrict` (the default on every reference) or `set-null`, refused on a required reference |
| `soft` | a reference whose target record — or collection — may not exist yet; `check` tolerates the miss, the stored value must still name an allowed collection |
| `sensitive` · `deprecated` | never exported · still validates, drawn nowhere, `dt add` warns on it |
| `body` | the prose field, `type: markdown` |
| `derived` · `virtual` | engine marks: stored but written only by the engine (`created`) · never stored (`id`, `last_modified`, a binary record's `ext` and `bytes`). A write naming either is refused |
| `passthrough` | the name keeps a harness's own spelling (`argument-hint`); without it a name that is not snake_case warns |
| `fields` · `values` · `item_title` | for `object`, `map`, rows of a `many` object |
| `examples` · `pattern` · `minimum` · `maximum` · `minItems` · `maxItems` · `minLength` · `maxLength` · `const` | passed to the validator; the first `examples` value is rendered into the orientation block's `write:` line |
| `display` | `editable` (`true` · `false` · `create`) · `hidden` (any of `list` · `form` · `record`) · `form_section` · `placeholder` · `unit` (`currency` · `percent` · `bytes` · a literal) · `unit_field` · `direction` · `width` · `viewer` · `editor` · `options` |
| `description` | what the value MEANS — the tooltip and the agent's guidance |

`display.editable: false` locks the surface and lets the CLI and syncs through; `mirror_of`,
`derived` and `virtual` refuse every writer. A required field with no default that is hidden from
the form or not editable is a compile error — nothing could create a record.

Every collection also carries three **injected** fields, never authored: `id` (virtual, the path),
`last_modified` (virtual, from git) and `created` — stamped into the frontmatter by `dt add`,
before the id is made, so `ids.from` may name it. A record written before the stamp existed reads
`created` from its id's date when `ids.from` names `created`, else from the commit that added the
file. A runtime kind (skills, agents…) has no `created`: compile writes those records.

## ids and templates

```yaml
ids:
  from: '{{ date | date:YYYY/MM }}/{{ date | date }}--{{ patient | basename }}'
  pattern: '^\d{4}/\d{2}/\d{4}-\d{2}-\d{2}--[a-z0-9-]+$'
```

- **`from`** is a template, or an ordered list of them: the first whose fields are all present
  wins, so `['{{ code }}', '{{ name | slug }}']` reads "the code, else the slugged name". Without
  `ids`, ids come from `{{ name | slug }}` — a collection with no `name` field declares `from`.
- **A collision at `dt add` is refused by name**; `--id` is the escape, for an id the operator chose.
- **`pattern`** must admit everything `from` produces, `/` included when the id shards.
- **The grammar is one, everywhere** — `ids.from`, `record_title`, `item_title`,
  `display.record.subtitle` and the layout options that take a template: `{{ field }}`,
  `{{ field | filter }}`, `{{ field | filter:arg }}`. A field is a declared one or `id` ·
  `created` · `last_modified`; `{{ seq }}` (a running number, `| pad:3`) exists only in an id.
  Filters: `date[:fmt]` · `datetime` · `slug` · `pad:n` · `basename` — nothing else. An unknown
  filter or field is a compile error naming the position.
- **A reference renders differently by position**: in an id, as the id it holds (`basename` takes
  the last segment); in a display template, through the target's `record_title`.
- **`slug` of a name with no Latin letters** falls back to a short hash; the write succeeds and says
  so. Give such a collection a Latin field to slug, or pass `--id`.

## display — the collection's default view

```yaml
display:
  nav:
    icon: pulse
    order: 20
    section: care                 # a free partition of the nav
  list:
    layout: table                 # the default; a surface's registered layout id
    columns: [reason, patient, date, status]
    sort: -date
    options:
      page_size: 50               # the layout's own keys
  record:
    layout: page                  # the default
    subtitle: '{{ patient }} · {{ kind }}'
    badge: status                 # drawn as a chip in the header
    color_by: kind                # a field whose enum map's colours tint rows and chips
  form:
    sections:
      - title: Visit
        fields: [reason, patient, date, status]
```

This block IS what a bare collection route renders and what `dt list` prints as columns. A
ui-view carries the same block and changes only what it states (`ui-views.md`). Every field it
names must exist — columns, sort, badge, color_by, sections — or compile names the position.
Layout options that take a field are named for the role (`group_by`, `lanes_by`, `color_by`,
`start`, `end`, `lat`, `lng`); those taking a template end in what they label (`card_title`,
`bar_title`, `group_title`, `group_summary`). Both kinds are checked; any other option key rides
through to the surface unchecked.

## the pipeline — what compile does to a descriptor

The compiled file is the authored keys, resolved, plus one `compiled:` block holding everything
compile decided. The order explains most "why does the compiled file say that" questions:

1. **Mixins merge in**, in list order — fields before the body field; `storage`, `ids` and
   `display` key by key where the descriptor is silent; `constraints` concatenate.
2. **Overlays merge onto the base** — new fields before the body, a field the base has merged key
   by key, every other key overlay-wins (`display` per sub-block).
3. **Names are checked** — every field `display`, `ids.from`, `storage.under.parent` and every
   template names; unknown keys in the closed blocks.
4. **Storage and fields resolve** — the storage defaults (an `owns_data` module's path prefixed
   with its root); a `format: binary` collection gets `ext` and `bytes` and may declare nothing
   else; titles, `on_delete`, the injected fields; then the validator's JSON Schema, which must
   itself compile, and `ids.pattern`, which must be a valid regex.
5. **The reference contract**, then **relations** — every `mirror_of` checked against its owner
   across ALL descriptors at once, because a relation spans two files — then placement.
6. **Bytes dump** to `.dreamteamer/collections/<name>.collection.yaml`. `compiled` holds `defaults`
   (every value compile supplied), `module`, `repo`, `runtime`, `under_collection`, `mirrors`,
   `overlaid_by`, `unresolved_peers`, `fields` (resolved) and `json_schema`.

**Read the compiled file to know what IS; edit the source to change it.** `compiled.defaults` is
the diff between what you wrote and what holds.

## the system and field verbs — writes through a compile gate

The sanctioned way to write schema without hand-editing. Every verb round-trips through a
**compile gate**, so a change that would not compile is rolled back — and unlike a record write, a
schema verb **commits its source write itself**. The verbs and flags are `dt help` under "system
verbs" and "field verbs". What help cannot tell you:

- **The field verbs write the OWNING module's descriptor** — the source that declares the
  collection, wherever it sits. `--module <m>` names another module, and the field then lands in an
  `overlay: true` descriptor there, which compiles only when `m` depends on the owner or names the
  collection in `peer_collections`; the refusal prints the `dt set modules/<m> dependencies=…` that
  fixes it. A module installed from `node_modules/` is read-only — overlay it.
- **`--type <collection>` is a reference**; `--many`, `--enum a,b`, `--mirror-of <field>` (the
  mirror of the `--type` collection's `<field>`) and `--soft` spell the keys above. `add-field`
  inserts before the body field; `set-field` never reorders.
- **`rm-field` clears the values in the same write and reports the count**, prunes the field from
  its own columns, sort, badge and sections, and **refuses while another position names it** — a
  view, a binding, a template — listing each one.
- **`rename-field`** rewrites the key in every record and every position that names it — templates,
  `ids.from`, `display`, constraints, `storage.under.parent`, a mirror's `mirror_of`, views and
  bindings — in ONE commit. **`rename-value`** does the same for one enum value.
- **`dt rename collections/<old> <new>`** moves the descriptor and its overlays, plus the
  records, the filenames and every inbound reference, in ONE commit. It refuses a runtime source,
  a placed collection (`relocate --to-root` first), an overlay that sets `storage`, one shipped
  from `node_modules/`, a taken name and an undeclared target namespace. It keeps a hand-set
  `storage.path` (records stay put, and it says so) and an authored `storage.suffix`.
- **An empty value removes** in dotted writes (`dt set ui-views/<id> display.list.sort=`); a
  setting whose meaningful value IS empty is written QUOTED: `'display.list.sort=""'`. A value
  holding `{{ }}` is quoted the same way.

## declaring a module

A module is a folder under `modules/<id>/` whose `package.json` carries **a `dreamteamer` key —
`"dreamteamer": {}` is enough** — plus the kind folders it ships (`collections/`, `skills/`,
`agents/`, `commands/`, `command-bindings/`, `ui-views/`, `mixins/`). Without the key the folder is
**silently ignored**; an unknown folder inside is a compile error unless `dreamteamer.ignore`
lists it. What belongs in a module is judgment — `data-modeling.md` Part III §8. A module's
`dreamteamer` block reads, for example, `{ "description": "…", "namespaces": ["billing"],
"dependencies": ["clinic"] }`.

| module key | what it holds |
|---|---|
| `title` · `description` | what to call the module · what the AREA is for — it heads the module's group in the orientation block |
| `namespaces` | the namespaces this module owns |
| `dependencies` | modules this one cannot compile without — an overlay needs its base. Acyclic |
| `peer_collections` | collections this module references but does not own, which may be absent |
| `owns_data` | its records live in its own clone, not the workspace's `data/` |
| `engine` | the engine range it needs; outside it, the module is refused whole |
| `env` · `vars` | the `.env` keys it needs · the `${env:…}` names its records use (the workspace must allow each) |
| `extension` · `ignore` · `local_assets` | an extension entry (`extensions.md`) · folders that are not kinds · gitignored files a worktree links |

## the workspace manifest — the `dreamteamer` block in `package.json`

Keys are snake_case and closed: compile refuses an unknown one, naming the list. `dt init` writes
`workspace_module`, `data_path`, `harnesses`, `git_modules`, `disable` and `gitignore_runtime_folder`.

| key | what it holds |
|---|---|
| `workspace_module` | which module under `modules/` is the workspace's own |
| `data_path` | where records live, workspace-relative |
| `namespaces` | namespaces declared at the workspace level (a module's own declaration is the one that travels) |
| `vars` | the `.env` keys records may reference as `${env:KEY}` (`records.md`) |
| `auto_commit` | whether a record write also commits (default off) |
| `harnesses` | which coding-agent adapters compile writes |
| `git_modules` | the lockfile map `dt install` restores into `git_modules/` |
| `disable` | what to drop from the compile: `modules/<id>` (a whole module, its code included) or `<kind>/<id>` (one entity) |
| `local_assets` · `postinstall` · `repos_path` · `gitignore_runtime_folder` | links a worktree gets · a script `dt install` runs · where `repos` records materialise · whether `.dreamteamer/` is gitignored |

The workspace's own instructions live in **`DREAMTEAMER.md`** at the root. Compile writes
`CLAUDE.md`, `AGENTS.md` and `GEMINI.md`: the generated orientation block first, then that file's
text, each in its own managed block. They are gitignored, so text written into them reaches no
other clone — edit `DREAMTEAMER.md`.

## namespaces — scoping a collection under a folder

| declare in the OWNING MODULE's `package.json` | create it | lands in | referenced as |
|---|---|---|---|
| `"dreamteamer": {"namespaces": ["health"]}` | `dt add collections --name doctors --module clinic` | `data/health/doctors/` | `health/doctors/dana-levi` |

A module declaring exactly ONE namespace **infers** it, and the resolved name is echoed. Two or more
and it refuses to guess: `--namespace health`. `--namespace ''` means none.

- **The default namespace is the empty prefix** — `tasks` stays `data/tasks/` and `tasks/kickoff`.
  `default` is RESERVED, so there is never a second spelling for one collection.
- ⚠ **A namespace must be declared before its collection compiles.** An id is also a slash path, so
  `a/b/c` is ambiguous without the declared set; an undeclared prefix is a compile error.
- **One owner per namespace** — two modules declaring it is a compile error naming both — and
  **using another module's namespace requires that module in `dependencies`**. The workspace's set
  is the union of every module's plus its own, so it follows the INSTALLED modules: removing a
  namespace-owning module re-splits every reference into it, and compile names the namespace.
- The descriptor lands at `collections/health/doctors.collection.yaml`; `type: health/doctors`,
  `disable: [collections/health/doctors]` and every record verb take the QUALIFIED name. Only the
  derived `title` drops the prefix. Nested namespaces work; the longest declared prefix wins.
- ⚠ **No collection may store records inside another's folder.** The one declared exception is
  the next section, where compile knows which files belong to whom.

## relationship-based storage — records beside the record they belong to

A collection can keep each record INSIDE the folder of its parent record, so a browse of
`data/companies/northwind/` shows the whole account. It is declared on the CHILD:

```yaml
# the parent, companies.collection.yaml — one folder per record
storage:
  shape: folder
  entry: company.md
```

```yaml
# modules/default/collections/meetings.collection.yaml
name: meetings
description: One calendar meeting — the event, never the company or the people in it.
use_when: anything with a date and attendees
storage:
  under:
    parent: company
    subfolder: meetings
ids:
  from: '{{ date | date:YYYY/MM }}/{{ name | slug }}'
  pattern: '^\d{4}/\d{2}/[a-z0-9-]+$'
fields:
  name:
    type: string
    required: true
    description: The calendar title.
  date:
    type: date
    required: true
    description: The day it happens.
  company:
    type: companies
    description: The account it belongs to — also which folder holds the file. Empty keeps it in data/meetings/.
```

```text
data/companies/northwind/company.md                            ← the parent: shape folder, entry company.md
data/companies/northwind/meetings/2026/10/kickoff.meeting.md   ← meetings/2026/10/kickoff, company: companies/northwind
data/meetings/2026/10/offsite.meeting.md                       ← meetings/2026/10/offsite, no company: the FALLBACK root
```

- **Still one collection.** `dt list meetings` is the union of every company folder and the
  fallback root; `dt get meetings/2026/10/kickoff` finds the file wherever it sits; a reference is
  `meetings/<id>` everywhere.
- **The id is independent of placement** (`under.id: independent`, the default).
  `dt set meetings/<id> company=companies/harbor` MOVES the file and changes nothing else; clearing
  the field moves it back. An id is unique across every root.
- **`under.id: nested`** makes the id BEGIN with the parent's id, for a collection whose identity
  already leads with it — lab values per patient. Every `ids.from` must open with
  `{{ <parent> | basename }}/`; the file drops that segment because the folder carries it
  (`health/lab-values/dana-levi/2026-07-02--ldl` lives at
  `data/health/patients/dana-levi/labs/2026-07-02--ldl.lab-value.yaml`). A change of parent is a
  `dt rename`, never a `dt set`.
- **`parent`** is a scalar reference to exactly ONE collection, which must be `shape: folder`.
  **`subfolder`** is a relative folder inside each parent record's folder, never its `entry`.
- **One level.** A placed collection cannot itself be a parent, and the child is a text record in
  file shape. Two children of one parent need two subfolders.
- **The field is the owner; the folder is observed placement.** A file under the wrong parent is
  `placed under … but <field> is …` in `check`, which changes nothing. `dt relocate <collection>`
  (or `<collection>/<id>`, `--dry-run` first) moves files to where the field puts them, and
  refuses whole on a dangling owner, an occupied destination, an unpublished source or a symlink.
- **A parent with records inside its folder cannot be removed** — not with `--force` either.
  Renaming it carries the folder and rewrites the children's owner field.
- **Adopting it on existing data**: make the parent folder shape and `relocate` it; add `under`
  to the child and compile (nothing moves at compile — `check` reports each mismatch); `relocate`
  the child. **Removing or changing it** is the walk backwards — `dt relocate <collection>
  --to-root`, edit, compile, `dt relocate <collection>` — and compile refuses the edit while records
  would be stranded inside parent folders.
- **When NOT to use it**: a record several parents share equally, an owner usually unknown, a
  collection nobody browses as a folder. It organises files; it grants nothing.

## mixins — a live shared field set

```yaml
# modules/clinic/mixins/clinic-provenance.mixin.yaml
name: clinic-provenance
description: Who made the record, from what, and how much to trust it.
use_when: every clinic collection an agent may write — list it rather than restating the three fields
fields:
  author:
    type: string
    description: Which agent made this record. Absent when a person wrote it.
  source:
    type: string
    description: Where the information came from.
  confidence:
    type: string
    default: normal
    enum: [low, normal, high]
    description: How much to trust this record. When low, say why in `source`.
```

A collection lists it: `mixins: [clinic-provenance]`. A mixin is a partial descriptor — `fields`,
and `storage`, `ids`, `display`, `constraints` where it says so — merged at every compile (the
pipeline, step 1), and a declared SOURCE of each consumer, so editing it marks them stale.

- **A descriptor cannot redeclare a mixin's field** — one source per field, a compile error naming
  both. Tighten by writing the field in the descriptor and not listing the mixin, or by a second,
  narrower mixin.
- ⚠ **A mixin id is global, so list only mixins your own module ships** (or the engine's): a
  collection listing another module's mixin cannot be copied or installed without it, and compile
  will not tell you. Scope the id per module (`clinic-provenance`, not `provenance`). The engine ships two every workspace has: `docs` (title · tags · content, a dated
  id) and `entity` (name · tags · notes, a slug id). `dt add collections --mixins docs` lists one.

## overlays — adding fields to another module's collection

```yaml
# modules/billing/collections/health/visits.collection.yaml
name: health/visits
overlay: true
fields:
  claim:
    type: billing/claims
    mirror_of: visit
    description: The claim this visit was billed under. Set `visit` on the claim.
```

The base is the one source of `health/visits` without `overlay: true`; two bases are a name
collision. An overlay **compiles only when its module depends on the base's module, or names the
collection in `peer_collections`** — then it applies while the collection is installed and is
inert while it is not. The workspace module gets no exemption. Overlays from two modules apply in
discovery order; keep them **disjoint**. ⚠ **An overlay can add or tighten fields, never remove
one** — fix the base when the shape is wrong for the module rather than for this workspace.

## enum maps — what a VALUE looks like

```yaml
kind:
  type: string
  default: follow-up
  enum:
    intake:
      label: Intake            # what a surface shows; the stored value is still `intake`
      icon: person-add
      color: charts.blue       # a theme colour id, never a hex
    follow-up:
      label: Follow-up
    urgent: {}
```

A list (`enum: [a, b]`) and a map hold the same value set; the map adds, per value, any of
`label` · `description` · `icon` · `color` · `background`, each a string — anything else is dropped,
so a descriptor cannot inject keys into the contract every surface reads. **Map order is band
order**: a board grouped by the field draws its lanes in it. `icon` names an icon in the surface's
set, or is a reference to a record of a binary collection (a reference always holds a slash).

## the reference contract — references across the module graph

Every reference target must be one of: an **engine** collection (the entity kinds plus `repos`) ·
a collection **owned by this module** · owned by a module in **`dependencies`** · or named in
**`peer_collections`** — or, for the workspace module, any installed collection. It is judged per
source: the module whose descriptor or overlay declares the field — or lists the mixin carrying it
— is the one that declares the target. Anything else fails compile with the fix in the message.

`dependencies` names MODULES, is hard and must be acyclic — compile prints the ring.
`peer_collections` names COLLECTIONS and exists for the ring case: two modules referencing each
other's concepts are two peer declarations instead. A peer nothing installed provides compiles,
is recorded in `compiled.unresolved_peers`, and `check` warns once with the count of references it
cannot resolve rather than failing them.

`type: reference` (any collection) is warned about outside the workspace module — an unverifiable
cross-module surface — and accepted inside it. A `soft: true` reference names its collections and
tolerates a missing record — for a value that is a declaration ("referred by Dr. X") rather than a
link the workspace already holds.

## registering an existing data folder

1. Sample the files: derive `storage.suffix` and `format` from the filenames (`<id>.<suffix>.<ext>`)
   and `ids.pattern` from the id shapes actually present.
2. Collect frontmatter keys across files → `fields`; infer types from values. Values shaped
   `<collection>/<id>` are reference fields. No frontmatter at all → `fields` with only the body.
3. Point `storage.path` at the folder — an authored path always wins over the default.
4. **Never edit the records to fit an inferred schema.** Describe reality, compile, run `check`,
   then decide which violations are worth fixing in the data.

## evolving a schema

Widening (a new optional field, a new enum value) is always safe; narrowing (a new required
field, a removed enum value) needs the data cleaned FIRST — measure, clean, *then* narrow, or
every later `check` drowns. The judgment is `data-modeling.md` Part IX; the mechanics: renames are
verbs (`rename`, `rename-field`, `rename-value`), and any other shape change across records is a
**one-shot script you write, run once and commit with the records it rewrote** — there is no
migration framework. Say in the commit message what it did; that message is the ledger.

## the message catalog — what compile and check are telling you

Compile fails closed and names its reasons. (⚠ = warning: it compiled, and you should still act.)

| the message says | it means | the move |
|---|---|---|
| `source(s) are in the v1 descriptor format` | a source in the format this engine does not read | run the converter it names; `UPDATING.md` has the walk |
| `unknown key … — a descriptor's keys are …` (or a field's, a storage's, a display's) | the closed lists | fix the key; the message lists the legal ones |
| `name collision on collection "<c>"` | two bases — a second source must be an overlay | `overlay: true`, or rename |
| `name collision on <kind> "<id>"` | two modules ship one entity — never merged | rename yours, or add `<kind>/<id>` to `dreamteamer.disable` |
| `every source declares overlay: true — no base found` | the base's module is not installed | install it, or declare the collection in `peer_collections` |
| `an overlay of "<c>", but module "<m>" neither depends on … nor declares …` | the overlay gate, the field verbs' `--module` included | `dt set modules/<m> dependencies=modules/<owner>` |
| `references "X", which module … neither owns nor declares` | the reference contract | add the dependency or the peer, as printed |
| `cyclic module dependencies: a → b → a` | concept links declared as module deps | move one to `peer_collections` |
| `has folder(s) that are not a known kind` | a typo'd kind, or a package folder | fix the name, or list it in `dreamteamer.ignore` |
| `display.list.columns names "x", which is not a field` (or sort, badge, sections…) | a name that does not exist | fix it — the message names the position |
| `record_title opens with "<f>", a <type> field` | `dt add "<title>"` fills the first token | open it with a string field |
| `is a SCALAR mirror, so <owner>.<f> must be a unique scalar reference` | one-to-one needs `unique: true` on the foreign key | declare it, or make the mirror `many` |
| `is a mirror, but <c> declares no body field` (or is binary, runtime, another repo) | the target cannot hold a generated field | add a body field, or drop the mirror |
| `every ids.from template must open with {{ <parent> \| basename }}/` | `under.id: nested` | lead the id with the parent |
| `internal: true is reserved` | a module put a domain collection in the plumbing partition | drop the line |
| `module X needs engine "…"` | its `engine` range excludes this engine; refused whole | upgrade dreamteamer, or disable it |
| ⚠ `"<name>" is not a plural the inflector knows` | `singular` falls back to the name | set `singular` (and `storage.suffix`) if `dt add` should take another word |
| ⚠ `field "<f>": names are snake_case` · `enum value "<v>" is not kebab-case` | a convention, not a rule — a rename is a record change | `dt rename-field` · `dt rename-value` when you choose |
| ⚠ `is type: reference outside the workspace module` | an unverifiable cross-module surface | name the collections it may target |
| ⚠ `has no description` · `use_when restates its description` | the orientation block renders a bare name, or the same words twice | write the sentence (`data-modeling.md` §18) |
| ⚠ `module X reads ${env:NAME} — add it to the workspace's dreamteamer.vars` | a module requests a var the workspace has not allowed | add the name to `dreamteamer.vars` |
| ⚠ `module X: <channel> copy shadows <channel> copy` | one module delivered twice — the more local wins | intended for dev; otherwise remove one |

`check` reports, and never modifies:

| check reports | it means | the move |
|---|---|---|
| `<field>: stale — run: dreamteamer relations rebuild <c>` | a mirror fell behind its owner — usually a hand edit | run it |
| `dangling reference "…" — no such record` | a deleted or hand-renamed target, or a typo | fix the ref, restore the target, or `dt rename` properly |
| `<field>: "<v>" is already taken by <c>/<id> (unique)` | two records claim one unique value | decide which is real; change the other |
| `placed under … but <field> is …` | a file in the wrong parent folder | `dt relocate <c>/<id>` |
| ⚠ `peer collection "<c>" is declared but not installed` | references into an absent peer, counted | expected when the module runs alone |
| a FLOOD of enum or required violations right after a schema change | the schema narrowed before the data was cleaned | widen back, clean, then narrow |

*(one failure has no message: a module folder whose `package.json` lacks a `dreamteamer` key is
silently not discovered.)*

## common mistakes

| mistake | reality |
|---|---|
| editing the compiled descriptor | `.dreamteamer/` is generated — edit the module source and compile |
| a second same-name descriptor without `overlay: true` | a name collision, by design |
| a plain string where a reference belongs | `type: <collection>` lets `check` and `rename` follow it |
| a `mixins:` id another module ships | that module can no longer be copied or installed alone |
| a `--module` field verb retried verbatim after the overlay refusal | declare the dependency it prints, or let the verb write the owning module |
| authored `singular` expecting the filenames to follow | `storage.suffix` is separate — set both |
| `storage.path` under an entity-kind name | it compiles as a runtime collection and becomes unwritable |
| ignoring a ⚠ because compile said ✔ | every warning above is a defect with a deferred bill |
