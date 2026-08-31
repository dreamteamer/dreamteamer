# data modeling — from a requirement to a model

The user states a requirement ("track the clinic's visits"); this turns it into collections, fields
and relations that are searchable, filterable and legible in any surface. Method here; mechanics
(meta verbs, namespaces, `templates:`) in `collections.md`. Propose before writing — descriptor YAML
per collection, ONE sample record (`dt add`, shown), the `dt schema` commands, and a "deliberately
not modelled" list; YAML in the proposal cannot drift from what gets written.

## the interview — nine questions, asked of the requirement

1. **Nouns.** Every noun the user would open, list or point at is a collection candidate; one that
   only appears inside another is a field or a nested object. Vitals nest on a `visits` record —
   until "blood pressure over time" is asked, and `lab-values` becomes a collection, one value each.
2. **The question.** Name the question the collection exists to answer, and write it into
   `description`. The GRAIN is the unit that answers it without unpacking.
3. **One record.** Identity is `id.generate`, from creation-time values only — and from the domain's
   own date, never `created`, which is when the record was WRITTEN (a back-dated import would file
   under the import month). Unbounded growth gets a `YYYY/MM/` prefix; `id.pattern` must admit `/`.
4. **Lifecycle.** What states, what moves a record between them, what "done" is. `status` is what a
   kanban view groups by and what a command-binding's `can-enter`/`can-exit` gates on. End of life
   is a state (`archived`), not `rm` — `rm` refuses while anything still points at the record.
5. **Stable vs volatile.** A thing and the churning activity about it are two collections
   (`health/doctors`, `visits`); a new version of one thing is git history, never a second record.
6. **Who points at whom, from which side.** Scalar or array; the many side owns the values, and the
   inverse is ONE keyword (`x-inverse`, or `x-inverse-of` from the other side), never a field you
   author. Add it when "which doctor has no visits" will be asked, not for the other direction.
7. **The forcing field.** One required field whose absence makes the record write-only — `dose` on a
   prescription. A collection without one is a list; say so.
8. **Units and time.** A number without its unit is a smell (`amount`+`currency`, `value`+`unit`).
   An instant is `--type datetime` (`format: date-time`, offset stamped on); a day is `--type date`.
   One operator over git: ownership and permissions are not modelled — invent no `owner` field.
9. **Names.** Collections plural and hyphenated (`lab-values` — `storage.suffix` derives as the
   singular, `<id>.lab-value.md`); fields snake_case; a reference named for the target's singular;
   the role, not the instance (`person`, not `staff-member`); the word the user says. A files folder
   is named for the collection that indexes it; a collection is for what RECURS, not a one-off.

## collection · field · enum · vocabulary · tags · nested — measured, not guessed

| the value… | model as | measure |
|---|---|---|
| has fields, a lifecycle, or is opened alone | a collection + `x-reference` | — |
| is a small closed set the domain defines | `enum` — never against records that already violate it, or `check` fails on every pre-existing value | `dt values <c> <f>` ≤ ~10 distinct, AND its counts summed ≥ 80 % of the rows `dt list <c> --json` returns — `values` reports distinct counts and never fill, plain `dt list` prints ids only, and a declared enum comes back echoed verbatim |
| is a vocabulary the workspace grows | free string — `dt values` IS the dropdown | the set is still moving |
| is a loose label with no attributes | `tags` — free strings, never a `tags` COLLECTION; a label reading like `key:value` is a field wanting to exist, so promote it | — |
| repeats inside one record, never referenced from outside | nested `array` of `object`, `x-title-template` on `items` | cost: not filterable (a non-operator key means a reference hop, so a nested key narrows to nothing), no `dt values` (objects are skipped), no list column — the form only |

## relations

Scalar `x-reference` = many-to-one; `+ x-unique: true` = one-to-one; array + inverse = many-to-many.
One-to-many is never authored — it is the MIRROR compile generates from a scalar. `x-unique` means
nothing without an inverse: it states the FK's cardinality, not a general uniqueness constraint.
Union targets = a list; `'*'` = open-world evidence/source fields only, and no inverse is possible on
one. Self-reference is legal. A junction is an ordinary collection with two references, and only when
the edge carries fields of its own. Inverse fan-in is a legibility cost, not a limit: measure it
(`dt list visits --where '{"doctor":{"_eq":"health/doctors/dana-levi"}}'`) and skip the inverse when
the mirror would outgrow the target's frontmatter, or the many side is machine-written every sync.
`x-on-delete`: `restrict` (the default) refuses the `rm` and names the records holding the FK,
`set-null` clears it.

## what each key does downstream (the projection contract)

| descriptor shape | presentation emits | a surface shows |
|---|---|---|
| `x-body: true` | `special: dt-body` | the page body, last |
| scalar / array `x-reference` | `dt-relation-path` (+`-list`) | record picker, labelled by the target's `title_template` |
| generated mirror | `readonly`, `inverse_of`, `dt-relation-mirror` | read-only chips + a hint |
| `enum` | `edit_options.choices` | dropdown |
| array of strings / of objects / object | `tags` / `list` / `nested` | chips / row editor / sub-form |
| `format: date` · `date-time` | `date` · `timestamp` | date / datetime control |
| `description` | `meta.description` | the tooltip |

Per collection: `description` (the question it answers, and the neighbour it is NOT) · `use_when`
(only where an agent that fully understood the description still would not reach for it) ·
`title_template` (authored once, inherited by every reference; a derivation to `{{ id }}` means no
name-like field exists) · `list_fields` (4–6 columns: the name, the sort key, the relation you filter
by — `last-modified` is injected) · `sort_field` (hand-ordered collections only) · `icon`/`order` (the
nav groups by owning module) · `storage.codec` (`md` when a human reads a body, else `yaml`; `file`
for bytes).

## rules

- **Denormalise a sort key, never content.** A `date` copied from the parent so lists sort without a
  join is right, and its `description` names the SOURCE and the WRITER or it rots. Content is never
  copied — the generated mirror exists for that.
- **Filters are one hop outbound, plus a declared inverse.** Inbound references are not supported: a
  two-hop question gets a denormalised key or a second command.
- **The body is for prose, fields are for questions.** Filtered/sorted/listed → a field; read once →
  the body; never filtered → a `description`, not a field.
- **Names are the UI.** Two confusable fields each say which is which; a collection is described by
  what it is NOT as much as by what it is.
- **Seed before you declare.** One real record through `dt add`, shown in the proposal.
- **Smells, when reviewing a model that exists:** a string field with ≤10 distinct values, ≥80 % fill
  and no enum · a field at 0 % fill after fifty records · an array of `<collection>/<id>` values with
  no `x-reference` · a `title_template` derived to `{{ id }}` · two collections sharing most of their
  fields with no reference between them · a `kind` enum whose members get triaged on different
  questions (split it) · a scalar reference with fan-in > 1, no inverse, and a saved view asking
  "which have none" · a body used as a list column · a number with no unit beside it · a nested
  object someone is trying to filter on.
