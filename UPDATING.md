# Updating dreamteamer

One section per release, newest first. Each says what you have to **do**, and most of the time the
answer is nothing but `dt compile`.

Two rules that hold for every version:

- **`dt compile` after upgrading, always.** The runtime under `.dreamteamer/` is gitignored build
  output. A new engine reading an old runtime is the normal state between `npm install` and the next
  compile, and it is not always a loud failure — so compile, then `dt check`.
- **A `dt check` clean before and after is the real test.** If it was clean before the upgrade and is
  clean after, the upgrade landed. If it was already reporting violations, fix those first, or you
  cannot tell what the upgrade did.

```bash
npm install dreamteamer@latest
npx dreamteamer compile
npx dreamteamer check
```

---

## 0.14.0 → 0.15.0

**`x-inverse` now GENERATES the other side of a two-way link. Compile FIRST, and read what it
says** — MOST of what 0.14 taught still compiles, with a warning naming the field to delete. Some
shapes are now REFUSED, and the complete list of those is at the end of this section. The one a
0.14 workspace is most likely to hit is there: both sides hand-authored AND the target-side field
listed in `required` warns about the duplicate declaration and then FAILS the compile.

`x-inverse` used to NAME a field you had authored on the target, and `check` verified that the two
sides agreed. It now generates that field. Compile stamps a `readOnly` mirror onto the target's
compiled descriptor — carrying `x-inverse-of: <owner>.<field>` and a description pointing back at
the owner — the store maintains its VALUES in the same write as every change to the owning side, and
`check` reports a mirror that has fallen behind as `stale`, naming the `dreamteamer relations
rebuild <collection>` that repairs it. The mirror is not writable: `dt set` on one refuses and names
the owning field to set instead.

**Three source spellings, one compiled pair.** A and B produce byte-identical output, so the choice
is only about where the sentence reads best.

```yaml
# A — on the owning side, the field that holds the foreign key
# collections/recordings.collection.yaml
meeting: { type: string, 'x-reference': meetings, 'x-inverse': recordings }

# B — from the target instead: author the field there, and say whose mirror it is
# collections/meetings.collection.yaml
recordings:
  type: array
  'x-inverse-of': recordings.meeting
  items: { type: string, 'x-reference': recordings }
```

Spelling B's authored field is folded into the owner and then regenerated, so its `description`
survives and every other keyword on it is dropped. Cardinality closes backwards: a SCALAR spelling-B
mirror means the foreign key is one-to-one, and compile writes `x-unique: true` onto it for you.

⚠ **Spelling C is the LEGACY MUTUAL one — `x-inverse` on both sides, each naming the other. It is
what 0.14's own docs taught, and it still compiles: a warning, not an error, for this minor.** Read
as two relations it is fatal (each side's mirror lands on the other's authored field), so compile
collapses it to ONE relation, warns once per pair, and names the side it made the owner and why. The
owner is the SCALAR side, because that is where the foreign key physically lives; where both sides
are the same shape it is the one declaring `x-unique`, and failing that the qualified field name
that sorts first. **The migration is to delete the field the warning says is now generated** and
keep the `x-inverse` on the owner. Its `description` is kept; every other keyword on it is dropped.

⚠ **A hand-authored field on the target that an owner's `x-inverse` names also warns**, for the same
reason and with the same fix: delete it. `description` and `x-title-template` survive; nothing else
does. A field of a genuinely DIFFERENT shape under that name is an error rather than a warning —
rename one of the two.

**Two new keywords, both on the owning side.** `x-unique: true` makes the link one-to-one, so the
generated mirror is a scalar rather than an array, and `check` reports a second owner claiming a
target that is already taken. `x-on-delete` says what removing a TARGET does to the records pointing
at it: `restrict` (the default) refuses the `rm` and names them, `set-null` clears the foreign key.

**New verb.** `dreamteamer relations [<collection>]` lists every pair the compiled runtime declares
— `owner.field → target.mirror`, with the cardinality and the delete rule. `dreamteamer relations
rebuild <collection> [--drop <field>]` regenerates mirror VALUES from the owning side, and is the
repair for a `stale` finding; `--drop <field>` removes a residue key left by a mirror the schema no
longer declares. You should rarely need `--drop` by hand — dropping an inverse through `schema
update-field --inverse=` (or removing the owning field) now clears the mirror's values in the same
write and commit, and reports the record count. It is there for a descriptor edited by hand.

⚠ **A record write now modifies files in OTHER collections.** Setting a foreign key rewrites the
generated mirror on the target record in the same write, so a single `dt add` or `dt set` leaves a
second collection dirty — rows the caller never touched. Anything that stages, diffs or counts what a
write produced sees two files where 0.14 produced one.

⚠ **`dreamteamer commit <collection>/<id>` now SWEEPS relation partners into the commit.**
Publishing one half of a pair leaves a HEAD that fails `check`, so the record-scoped form also
publishes the partner records whose edge to a named record moved since HEAD — and REFUSES, naming
every party, when another session has moved an edge in one of the same files. **A script that assumed
a record-scoped commit touches exactly one file is affected.** The whole-collection form
`dreamteamer commit <collection>` is unchanged — it still publishes exactly that collection, and now
warns which partner records it left pending, with the command that publishes them.

**The schema verbs learned the relation flags.** `schema add-field` and `schema update-field` both
take `--many`, `--inverse [name]`, `--unique`, `--on-delete restrict|set-null` and `--mirror-of
<collection>.<field>`; a bare `--inverse` derives the mirror's name from the owning collection.
`--inverse` on an EXISTING reference is the migration path — a plain foreign key gains its mirror
without restating `--type`, and the records written before the mirror existed are counted for you,
with the `relations rebuild` that repairs them.

⚠ **`update-field` now CARRIES THE WHOLE PROP forward, not just the relation keywords.**
Restating a field to change its description used to rebuild the prop from the flags alone and write
back a plain `{type: string}`. That did not only lose foreign keys — measured on 0.14, one
`update-field --description "…"` turned `{type: string, format: markdown, x-body: true}` into
`{type: string}`, dropped an `enum` to a free string, collapsed `{type: array, items: …}` to a
scalar, and turned a `number` with `default`, `minimum` and `maximum` into a bare string. The rule
now: **a flag that was passed speaks for what it owns, and everything else comes from the previous
prop.** `--type` still owns the whole shape, so a deliberate retype behaves exactly as it did and
takes the old constraints with it. A flag that CLEARS still clears (`--inverse=` drops the mirror,
`--unique false` clears the one-to-one). Two things worth knowing: the HTTP whole-prop path carries
nothing behind its back (it signals itself by passing no flags), and a carried `items` arrives
stripped of relation keywords, so `--inverse=` can still drop a mirror on a list. And an
`update-field` that would change nothing now exits 0 saying so, instead of rewriting an identical
file.

**`--options a,b` and `--default-value` were fixed alongside it.** `--options` with no `--type enum`
used to build no enum at all; it now restates an existing enum's values. `--default-value` was
coerced against a `string` default rather than the field's real type, so `--default-value 7` wrote
the string `"7"` into a number field.

**`--body` marks the field that holds a record's markdown body**, on both `add-field` and
`update-field` — the flag the `x-body` compile refusal below tells you to use. It is carried forward
like everything else; `--body false` clears it.

**Descriptor comments now partly survive a schema verb.** They used to be deleted wholesale. `add-field`
and `remove-field` now reattach TOP-LEVEL comment blocks. Nested comments, and inline `{a: b}` mappings
reflowing to block form, are still lost — and a record write still re-wraps the whole record's folded
scalars. That is one cause (the engine parses to a plain object and re-emits) and the full fix needs a
round-trip YAML library, so treat a hand-commented descriptor as something to check after a schema verb
touches it.

⚠ **The COMPLETE list of what compile now REFUSES.** Each failure names the field; the fix is
beside it. Several of these were perfectly legal in 0.14, where `x-inverse` only pointed at a field
you had already written by hand and nothing was ever generated onto anybody.

- **A `required` list naming a generated mirror.** The mirror is `readOnly`, so the record could
  never be written at all. Drop it from `required`, or drop the `x-inverse` that generates it. ⚠
  **This is the 0.14 shape most likely to break on upgrade** — both sides authored, target-side
  field required, which is what the old worked example looked like. It warns about the duplicate
  declaration, then fails.
- **`x-inverse` on `x-reference: '*'`.** A wildcard has no single target to stamp a mirror onto.
  Drop the `x-inverse`, or name the collections the field may point at.
- **A mirror onto a `codec: file` collection.** The bytes ARE the record, so there is no frontmatter
  to hold a generated field. Leave the link one-way.
- **A mirror onto a `codec: md` collection that declares no `x-body` field.** `serialize` keeps a
  record's body only where the descriptor declares that field, so a mirror write would rebuild the
  file without any prose it holds — silently, in a collection nobody named. Declare an `x-body` field
  on the target, or leave the link one-way. (`dt schema add-collection` with no template produces a
  collection with none.)
- **`x-unique` on an ARRAY foreign key.** x-unique states that the foreign key is one-to-one, which a
  list cannot be — and the components read the contradiction differently. Drop `x-unique`, or make
  the field a single reference.
- **A mirror onto a runtime-based collection.** The store would write into `.dreamteamer/`, which
  the next compile overwrites. Leave the link one-way.
- **An `x-inverse` whose owning module does not declare a dependency on the TARGET's module.** The
  owner stamps a field onto another module's collection, so it may not do that silently — add that
  module to `dreamteamer.dependencies`, or leave the link one-way. (Only the workspace module is
  exempt.) 0.14 could not hit this, because nothing was stamped anywhere.
- **An `x-inverse` crossing `storage.repo`.** The mirror is written in the same act as the foreign
  key, and one commit cannot span two repos. Leave the link one-way.
- **`x-on-delete: set-null` on a `required` field.** Clearing the FK would produce an invalid
  record. Use `restrict`, or drop the `required`.
- **Two relations generating the same mirror name on one target.** One field cannot hold two
  relations, and no rebuild could ever satisfy both. Give one of them a different `x-inverse` name.
- **A both-sides declaration whose two sides disagree about the field name.** Keep one.
- **`x-on-delete: set-null` on a LIST with a floor above one** (`minItems: 2` or more). Clearing the
  foreign key would leave a record below its own floor — measured on 0.14 as a green `rm` followed by
  a `check` failure on a record nobody touched. `minItems: 1` still compiles: the last entry takes the
  key with it, and an absent key reads as empty.
- **A second `x-body` field on one collection.** Every reader takes the FIRST, so the second could
  never receive the body, and `serialize` would write the prose back under the first key — moving a
  record's content between fields. One body per collection.

Two things now WARN rather than refuse, both silent in 0.14: `x-unique` with no `x-inverse` (it is
not a JSON Schema keyword and nothing enforces it on its own, so it did exactly nothing), and the
legacy mutual spelling described above.

---

## 0.13.4 → 0.14.0

**A record can now BE a file: `storage.codec: file`. Nothing to migrate** — it is a new codec, and
no existing collection declares it.

```yaml
storage:
  path: data/assets
  codec: file          # the FILE is the record: no frontmatter, any extension
  shape: file
  suffix: asset
  max_bytes: 204800    # optional, this is the default — `check` reports anything over it
  extensions: [svg, png, jpg, jpeg, webp, gif]   # optional; omitted means any
id: { pattern: '^(icons|logos|images)/[a-z0-9][a-z0-9/._-]*$' }
```

`data/assets/logos/monday.asset.svg` is then the record `assets/logos/monday`, and any field can
point at it with an ordinary `x-reference: assets`. Use it for icons, logos, illustrations and
images — the things a UI shows and a text record cannot hold.

**What is different about an opaque record**, all of it a consequence of having no frontmatter:

- **Its fields are DERIVED, not authored**: `ext` and `bytes`, materialized as the collection's
  schema at compile so `dt values`, the form and every other reader work unchanged. A `schema` in
  such a descriptor is ignored, and compile warns; a `schema` is no longer required on one.
- **It is written by importing a file**: `dt add <collection> <id> --from <path>` — the id is
  positional (nothing can generate it from fields that do not exist), and the file's extension
  becomes the record's. `--force` replaces an existing one, removing its predecessor if the
  extension changed.
- **`dt set` REFUSES it**, naming the `add --from … --force` that replaces it instead.
- **One id is one file.** Two extensions under the same id is a `check` violation rather than a
  silent pick.
- `rm`, `rename`, `history`, `diff`, references and `check`'s dangling-reference rule are unchanged
  — a file record is a record. `diff` on a binary is git's `Binary files … differ`.
- **`shape: folder` with `codec: file` is refused at compile**: a file codec is one file.

⚠ **`check` grew two findings for these collections** — a file over `max_bytes` and an extension
outside `extensions`. Neither can fire on a workspace that declares no file-codec collection.

**`x-reference` now accepts a LIST of target collections — a union. Nothing to migrate** — values
on disk stay fully qualified `<collection>/<id>` in every case, whichever member of the union they
took, so a union is purely a widening of what a descriptor may DECLARE, not a change to what a
record HOLDS.

```yaml
about: { type: string, 'x-reference': [meetings, 'finance/accounts'] }
```

`'*'` (any collection) is unchanged — it was never a special case of the list form and still isn't.

⚠ **The one thing that can break an existing descriptor on upgrade.** `x-inverse` and
`x-title-template` are now normalized at compile onto the node that CARRIES `x-reference` — `items`
for an array field, the property itself for a scalar one; every runtime consumer used to read both
places. A descriptor that hand-authored either keyword on BOTH the property and its `items`, with
different values, used to silently prefer one; **compile now FAILS, naming the field.** Run
`dt compile` after upgrading — a fresh failure here means resolve the duplicate and keep one
spelling. Authoring the keyword on only one of the two, as every descriptor in this vault already
does, is unaffected.

**`presentation.relations` now emits one row per union member**, so `(collection, field)` is **no
longer a unique key** in that array — a union field with three targets produces three rows sharing
the same pair. A consumer written as `relations.find(r => r.field === f)` now silently sees only the
first member; switch it to `.filter(...)` if you have one. A title template is still inherited onto
those rows only when every member's target collection agrees on one — a template that renders half
the values wrong is worse than the raw qualified ref.

**Bare ids are now accepted on input for single-target reference fields.** `dt add notes --about
standup` qualifies to `meetings/standup` before it reaches disk, at the same choke point
(`validate()`) that already canonicalizes datetimes — so a CLI flag, a form widget and an agent can
all write the short spelling and the file still carries the one canonical qualified form. Union and
`'*'` fields still require the fully qualified spelling on input: the prefix is the only type
information those values carry, so there is nothing to infer it from.

---

## 0.13.3 → 0.13.4

**Saving a ui-view that a MODULE ships used to fail. Fixed — nothing to do but `dt compile`.**

`saveUiView` wrote every view into the workspace module's `ui-views/`, whoever shipped it. For a view
another inline module ships that produced a SECOND file carrying the same id, compile refuses that by
name, and the gate rolled the whole write back — so the surface reported

```
name collision on ui-view "health-labs-abnormal"
  - modules/default/ui-views/health-labs-abnormal.ui-view.yaml
  - modules/family/ui-views/health-labs-abnormal.ui-view.yaml
```

instead of saving. Every module-shipped view in a multi-module workspace was unsaveable, and the
error named the symptom rather than the cause. A view is now written back to the source it already
has, exactly as `collections rename` writes a descriptor back to the module that ships it. The test
that decides is `node_modules/`, not "which module": a write there is erased by the next
`npm install`, so it is refused with a message that says so. `removeUiView` follows the same rule.

**Comments survive a save now.** A ui-view source is where a workspace writes down why the view
exists, and `dump` cannot round-trip comments. A comment block above a TOP-LEVEL key is carried back
above that same key; the file header comes with it. ⚠ A comment above a NESTED key is still lost —
re-placing it would risk attaching an explanation to something it does not explain.

---

## 0.13.2 → 0.13.3

**A one-hop relational filter over a NAMESPACED collection matched zero records. Fixed — run
`dt compile` and re-run any filter you had written off as "no results".**

`recordResolver` split a reference at the first slash, so `family/people/dana-levi` asked the store for
the collection `family` — a namespace, not a collection. The read threw, the resolver returned null,
and `filter.js` treats an unresolvable ref as NARROWING. So this matched nothing, in silence:

```bash
dt list family/health/lab-results --where '{"person":{"name":{"_eq":"Dana Levi"}}}'   # 0 rows
dt list meetings --where '{"company":{"name":{"_nnull":true}}}'                        # worked
```

The difference was never the filter — it was whether the target collection lived in a namespace.

⚠ **Not only filtering.** The same resolver evaluates command-bindings' `can-enter` / `can-exit`,
so a binding predicate that hopped a namespaced ref reported the command as *not available*. If you
have bindings over namespaced collections, re-check `dt commands <ref>` after upgrading — commands
may now correctly appear that were silently missing.

Nothing to migrate: no record, descriptor or view changes shape. Filters that returned nothing start
returning rows.

---

## 0.13.1 → 0.13.2

**compile now WARNS when a ui-view hides a real field inside `options`. Nothing to migrate** — run
`dt compile` and read what it says.

`options` is a deliberately open object: every key it does not own rides through untouched to
whichever surface renders the layout. That openness has one sharp edge — a field belonging one level
up, written inside it, was accepted, saved, round-tripped and read by nobody:

```yaml
# silently inert — the view drew every record
options: { filter: { flag: { _in: [high, low] } } }

# what it has to be
filter: { flag: { _in: [high, low] } }
options: { sort: -date }
```

- It is a **warning, not a failure**: `options` is open by contract and a surface may legitimately
  want a colliding key. But the symptom of getting it wrong is a view that *looks* like it works, so
  the operator has to be told.
- It covers **every field `ui-views` owns**, read from the merged descriptor rather than a hardcoded
  list — `filter`, `sort`, `columns`, `path`, `layout` and anything the collection grows later.
- A genuine layout option (`group-by`, or whatever a module's own list registers) is untouched.

---

## 0.13.0 → 0.13.1

**A namespaced collection's DERIVED title no longer repeats its namespace. Run `dt compile`** — that
is the whole migration, and only the label changes.

An unauthored `title` was title-cased from the QUALIFIED name, so `health/doctors` resolved to
"Health Doctors" and `rnd/prototypes` to "Rnd Prototypes". Every surface that draws a namespace as a
folder then said it twice on one screen — "Health > Health Doctors". It derives from the BARE name
now: **Doctors**, **Prototypes**.

```bash
npm install dreamteamer@0.13.1
npx dreamteamer compile      # the labels change here, nothing else
```

- **An authored `title` still wins**, unchanged. If you worked around this by writing a title on every
  namespaced collection, nothing breaks — those titles are simply no longer load-bearing, and you can
  delete the ones that only restate the bare name.
- **A collection in the default namespace is unaffected**, and so is one whose slash-prefix was never
  declared: an undeclared prefix is not a namespace, so there is nothing to strip and the whole name
  stays in the label.
- ⚠ **If you were relying on the prefixed label to tell two collections apart** — `services/accounts`
  and `finance/accounts` both derive "Accounts" now — author a `title` on one of them. The nav folds
  them under different folders, but a flat list will show the same word twice.

---

## 0.12.1 → 0.13.0

**`dt commit` now takes a record REFERENCE as well as a collection. Nothing to migrate** — every
existing spelling means exactly what it did — but if two agents or two sessions ever share one
workspace, the new form is the one to use.

```bash
dt commit finance/transactions/2026/03/rent   # NEW: exactly that record
dt commit finance/transactions                # unchanged: the whole collection
dt commit contacts/jane companies             # targets mix freely, in any order
dt commit                                     # unchanged: everything pending
```

`-m <subject>`, `--dry-run` and `--json` are unchanged and work with every target shape.

**Why.** `dt commit <collection>` publishes everything dirty under that collection's record
directories *regardless of who wrote it*. With one session on a workspace that is the whole point;
with two, one session's commit silently swallows the other's pending records — and because
`git status` is clean afterwards, the sweep leaves no trace to notice. A reference makes the
narrow ask sayable.

**What deliberately did NOT change: the sampler.** The set of things to commit is still sampled
from `git status` over the record directories, which is what makes a record you hand-edited in a
markdown body indistinguishable from one the store wrote — publishable by the same verb, with no
pending file and no cursor to disagree with reality. Only the *targeting* narrowed: the sampled rows
are filtered against what you asked for. Two consequences worth knowing:

- A target naming an unknown collection, or an unknown id under a known one, **fails before
  anything is committed** (exit 1) rather than reporting "nothing pending" — a typo'd id used to be
  indistinguishable from success. A record that exists and is simply already published still reports
  `nothing pending`, as before.
- A reference is resolved against the declared collections, so a namespaced collection with a
  path-shaped id reads correctly: `finance/transactions/2026/03/rent` is one collection and a
  three-segment id, not collection `finance`.

---

## 0.12.0 → 0.12.1

**One silent-failure correctness fix in `${env:…}` resolution. Nothing to migrate**, but if a
declared var's value in `.env` is empty or whitespace-only, re-check anything that consumed the path
it used to render.

A key that is declared in `dreamteamer.vars` and present in `.env` with an **empty value**
(`FILES_FOLDER=`) used to pass `renderTemplate`'s gate and render to an empty string, exiting 0 —
`dt resolve '${env:FILES_FOLDER}/invoices/x.pdf'` printed `/invoices/x.pdf`, a plausible-looking
absolute path pointing nowhere near the intended file, and every consumer walked it happily. An
unset key already failed loudly; an empty one did not, which is exactly the failure class `${…}`
templates exist to eliminate. An empty or whitespace-only value now fails with the same message as
an unset key — the two are indistinguishable from outside and an operator does not need to tell them
apart. `compile`'s declared-var warning had the identical blind spot (a present-but-empty value was
never named) and is fixed the same way, so `compile` and `resolve` still agree on every `.env` line.

This is also the first published tarball carrying the dogfood-vault identifiers anonymised out of a
`renameCollection` comment (no behavior change).

---

## 0.11.0 → 0.12.0

⚠ **BREAKING: the CLI is verb-first.** `dt <collection> <verb> …` is gone. Every command is now `dt
<verb> [<target>] [flags]`, over a closed set of verbs — an unrecognised one fails loudly:

```
✖ unknown verb "<x>" — dreamteamer is verb-first since 0.12.0: dt <verb> [<target>]
```

**There is no alias layer, and none is coming.** A stale noun-first script must fail loudly, not
half-work — the predecessor grammar made the fallback a collection lookup, so a typo answered
"unknown collection", a true sentence about the wrong thing. Grepping your own scripts, aliases and
CI jobs for the old shape is the whole migration; there is no compatibility window to lean on
instead.

### The complete mapping

Record verbs keep their name; only the word order changes — the collection (or `<collection>/<id>`
reference) moves from being the first argument to being the argument AFTER the verb:

| 0.11.0 | 0.12.0 |
| --- | --- |
| `dt <collection> list …` | `dt list <collection> …` |
| `dt <collection> get <id> …` | `dt get <collection>/<id> …` |
| `dt <collection> add --<field> <value> …` | `dt add <collection> --<field> <value> …` |
| `dt <collection> set <id> <field>=<value> …` | `dt set <collection>/<id> <field>=<value> …` |
| `dt <collection> rm <id> …` | `dt rm <collection>/<id> …` |
| `dt <collection> rename <old-id> <new-id>` | `dt rename <collection>/<old-id> <new-id>` |
| `dt <collection> move <id> --after\|--before <id> \| --top \| --bottom` | `dt move <collection>/<id> --after\|--before <id> \| --top \| --bottom` |
| `dt <collection> move --init` | `dt move <collection> --init` |
| `dt <collection> values <field> …` | `dt values <collection> <field> …` |
| `dt <collection> history <id> …` | `dt history <collection>/<id> …` |
| `dt <collection> diff <id> …` | `dt diff <collection>/<id> …` |
| `dt <collection> revert <id> --hash <sha>` | `dt revert <collection>/<id> --hash <sha>` |
| `dt commands for <collection>[/<id>] …` | `dt commands <collection>[/<id>] …` |
| `dt repos ensure <id> \| --all …` | `dt ensure <id> \| --all …` |

The schema group (write SOURCES through a compile gate, never the runtime) got its own verb prefix
rather than sharing the record verbs' spellings:

| 0.11.0 | 0.12.0 |
| --- | --- |
| `dt collections add --name <name> …` | `dt schema add-collection --name <name> …` |
| `dt collections rm <name> …` | `dt schema rm-collection <name> …` |
| `dt collections rename <old> <new>` | `dt schema rename-collection <old> <new>` |
| `dt <collection> add-field --name <field> …` | `dt schema add-field <collection> --name <field> …` |
| `dt <collection> update-field --name <field> …` | `dt schema update-field <collection> --name <field> …` |
| `dt <collection> remove-field --name <field>` | `dt schema remove-field <collection> --name <field>` |
| `dt ui-views add --path </route> …` | `dt schema add-view --path </route> …` |
| `dt ui-views set <id> <key>=<value> …` | `dt schema set-view <id> <key>=<value> …` |
| `dt ui-views rm <id>` | `dt schema rm-view <id>` |

Workspace verbs are **unchanged**: `init`, `install`, `update`, `compile`, `check`, `status`, `start`,
`changes`, `commit`, `help`, `--version`. None of these ever took a collection as its first argument,
so there was no noun to move.

A `<collection>/<id>` argument in the new grammar splits at the **longest declared namespace prefix**
(unchanged from 0.7.0's rule), so `finance/transactions/2026/03/coffee` is still one argument, not
three.

### New: `${…}` templates + `dt resolve`

A record field may now hold a **VS Code-grammar template** — `${env:NAME}`, `${workspaceFolder}`,
`${userHome}` — for a value that differs by machine. Nothing on the read side substitutes it:
`get`, `list`, `check`, the REST server and the file on disk all show the raw template verbatim.
**`dt resolve` is the only place a template becomes a value.**

`${env:NAME}` renders only when `NAME` is BOTH declared in the workspace's own `package.json` and
present in `.env` on the machine running `resolve` — a template can reference a secret without ever
holding one. A worked example (values invented for illustration, not real):

```json
// package.json
"dreamteamer": { "vars": ["FILES_FOLDER"] }
```

```bash
# .env
FILES_FOLDER=/Volumes/annex
```

```yaml
# a record field
source_file: ${env:FILES_FOLDER}/scans/invoice-2026-03.pdf
```

```bash
dt resolve records/some-id source_file
# /Volumes/annex/scans/invoice-2026-03.pdf
```

`dt resolve '<string>'` also renders a bare string directly — useful for testing a template before
it lands in a record. An un-namespaced `${VAR}` (no `env:`, `workspaceFolder` or `userHome`) is
inert and passes through unchanged, so record prose can mention `${…}` freely without it being
mistaken for a template. `dt compile` warns, per declared var, when `dreamteamer.vars` names a key
missing from `.env` — names only, values never reach any output.

---

## 0.10.0 → 0.11.0

**Do nothing but `dt compile`.** One optional descriptor key and one new verb. Nothing existing
changes shape, no record is touched, and a collection that does not opt in behaves exactly as before.

**Collections can declare a field that holds MANUAL order.** Drag a record above another and it stays
there, at a cost of one changed file per move.

```yaml
sort_field: rank          # names a field this collection's own schema declares
schema:
  properties:
    rank:
      type: string
      pattern: '^[a-z]+$'
```

Then:

```bash
dt tasks move --init                     # place records that have no value yet (idempotent)
dt tasks move <id> --after <id>          # …or --before <id>, --top, --bottom
dt ui-views set tasks-board options.sort=rank
```

Three things worth knowing before you use it:

- **The field name is yours.** `sort_field` names it, exactly as Directus does; nothing in the engine
  spells it. Call it `position`, `rank`, `sort` — whatever reads right in your workspace.
- **The value is a fractional index, not an integer**, so inserting between two records changes only
  the record that moved. An integer would renumber everything below it, which against git is a
  commit that buries what actually happened.
- ⚠ **Use the pattern `^[a-z]+$`.** `compareValues` sorts with `localeCompare`, which is locale-aware,
  so the usual base-62 alphabet mis-sorts here — three prepends produce `Zy Zz a0` and the list comes
  back `a0 Zy Zz`. This is the same trap that breaks fractional indexing on PostgreSQL under
  `en_US.utf8` instead of `C`. Lowercase a-z is the range where locale order agrees with codepoint
  order and no value can be read as a number. `dt <collection> move` always writes keys in that range.

Records with no value sort FIRST, so a newly added record surfaces at the top rather than hiding at
the bottom. `move` refuses to place a record next to one that has no value yet, and says to run
`move --init` — it will not guess.

New in the HTTP API: `PATCH /api/collections/:name/position/*id` with `{ after | before | top |
bottom }`.

---

## 0.9.1 → 0.10.0

**Do nothing but `dt compile`.** The orientation block in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` /
`.cursor/rules/dreamteamer.mdc` grows three derived sections, and one optional descriptor key
appears. Nothing existing changes shape, and no record is touched.

**The block now names your collections.** Until now it stated the *grammar* — what a record file is,
what a reference looks like, which namespaces are declared — and not one noun any of it could be
about. It now carries:

- **COLLECTIONS** — every non-schema-ops collection with its `description:`, grouped by namespace,
  alphabetical within; schema-ops collections collapse to one line. Preceded by the two sentences
  that make the rest safe to omit: the descriptor is the authority on fields and id shape, and
  `dt <collection> add` generates the id and rejects invalid writes before disk.
- **CROSS-CUTTING TEMPLATES** — each `collection-template` rendered from its own `description:`.
- **VERBS BOUND TO COLLECTIONS** — every command-binding grouped by collection, with `can-enter` /
  `can-exit` rendered literally (`enter: status=draft`). This one is on every harness: native
  command discovery tells an agent what a command does and never what it acts on.
- **A command index** for codex / pi / gemini-cli / cursor only. claude-code discovers commands
  natively, so an index there would be a second copy.

⚠ **No record counts, deliberately.** These files are committed, so a number that changes on every
write would re-dirty three tracked files on every compile — and be stale when printed. Ordering is
stable so the block diffs only when your schema actually changed.

### New: an optional `use_when` on a collection descriptor

```yaml
name: issues
description: A defect found while using one of your own repos, with the evidence that proves it.
use_when: you are about to diagnose a defect in one of your repos — search here first
```

A `description` says what a record **is**; for most collections that is also when to reach for it,
and this key should be **absent**. Author one only when an agent that fully understands the
description would still not know to reach for the collection — a prior-art index whose trigger is
"before you derive" is the case it exists for. It is a **when**, never a how: procedure belongs in a
module's skill.

### New: compile warns on a collection with no description

Non-blocking and named per offender, the same shape as the per-missing-env-key warning. A descriptor
with no `description:` renders as a bare name in the block every session loads. There is deliberately
**no** equivalent warning for `use_when`.

---

## 0.9.0 → 0.9.1

**Five bug fixes in `collections rename` and the store. Nothing to migrate**, but if you ran
`dt collections rename` on 0.9.0, read the last item — it may have cost you something silently.

1. **A SELF-reference inside the renamed collection was not rewritten.** The ref pass ran AFTER the
   record folder moved, so it walked the old (now empty) path. A record pointing at its own
   collection dangled. Found on a `finance/accounts` where every card carries `settled_by`.
2. **`recordFiles()` yielded every module source TWICE** — the `modules` collection's storage.path is
   `modules`, and `sourceRoots()` includes the workspace root. Harmless while rewrites were
   idempotent; namespacing is not (`rnd/docs/x` still contains `docs/x`), so the second pass wrote
   `rnd/rnd/docs/x`. `findInboundRefs` was double-counting for the same reason.
3. ⚠ **A rename DESTROYED every comment in the descriptors it touched** — `load` → mutate → `dump`,
   in two places: the descriptor write and the `x-reference` retarget. 194 comment lines across 24
   descriptors in one real migration, including headers stating what a collection is for. Both are
   textual edits now, each proved by re-parsing.
   **If you renamed a collection on 0.9.0, check `git show <rename-commit>~1:<old-path>` for comments
   that are no longer there.**
4. **Rollback restored reference files before undoing the folder move**, so a self-referencing file's
   path no longer existed and the ENOENT masked the real error.
5. **`compile` never pruned `.dreamteamer/modules/`.** A renamed or removed module left a stale
   record behind listing collections that no longer exist, which `check` then read as dangling.

---

## 0.8.0 → 0.9.0

**`dt collections rename` now works on a collection a MODULE ships.** Nothing to migrate; this only
removes a refusal. `dt compile` after upgrading, as always.

### What changed

The guard derived the descriptor's location from the workspace module, which silently meant "only the
workspace module's own collections can be renamed". A workspace's domain collections almost always
live in a module — that is what modules are for — so the verb refused the migration it was built to
perform. One vault hit it on 26 of 26 collections it wanted to namespace.

The guard's real job is to stop a write that gets **erased**, and only `npm install` does that. So the
test is now `node_modules/`, and the descriptor is rewritten **in the module that ships it** rather
than moved into the workspace module.

Two cases are still refused, each naming why:

- **installed from `node_modules`** — "a write there is erased by the next `npm install`"
- **overlaid** (two modules contribute a descriptor) — the overlay's `extends` names the base by its
  current id, so moving the base alone would break it. Merge or remove the overlay first.

⚠ **Cost, measured rather than guessed:** the rename runs one full pass over every record file per
record id. A 2,291-record collection in a 3,391-file workspace takes **3 minutes** (142s of it system
time) even when nothing references it. Fine once; it is O(records x files), so budget accordingly on a
much larger tree.

---

## 0.7.0 → 0.8.0

⚠ **BREAKING: the `users` collection and the `@me` filter token are gone.** If your workspace has
neither an `x-reference: users` nor an `@me` anywhere, there is nothing to do beyond `dt compile`.

**Also: `dt init` now names the workspace module `default`, not after the directory.** This affects
**new workspaces only** — an existing `package.json` already carries a `workspace-module` key and it
still wins, so nothing moves and there is nothing to do. `--workspace-module <name>` overrides it.

Why: named after the workspace, that folder went stale twice in one repo, and each
rename had to rewrite every path that *resolves* while the historical documents kept the old spelling
— so the old `modules/<vault>` was correct in prose and a bug in a path. A role name cannot go
stale. `default` is deliberately the word `RESERVED_NAMESPACES` holds: this module owns the
default-namespace collections, and the default namespace is the empty prefix. `default/tasks` is still
a compile error, and its message says why.

**Why:** `users` was core on a circular justification — it existed because `@me` resolved against it,
and `@me` existed because `users` was core. Nothing in the compiler, the store or `check` ever read a
user record. It was one record per workspace whose only job was to restate `git config user.name` in a
file that then had to agree with it — and when it did not, the symptom was an empty inbox with no
error. Read the operator from git where you need one.

### Required, if you used either

Both failures are LOUD by design — you will not discover this from a view that quietly shows nothing.

1. **A ui-view filtering `@me` now fails compile**, naming the view and the fix. Rewrite it to filter
   on a field you own:

   ```diff
   - filter: { assignee: { _eq: "@me" } }
   + filter: { status: { _eq: todo } }
   ```

2. **A descriptor declaring `x-reference: users` now fails compile** — `users` left
   `CORE_COLLECTIONS`, so it is a target no module provides. Either drop the field, or point it at a
   collection you ship:

   ```diff
   - assignee: { type: string, x-reference: users }
   + assignee: { type: string, x-reference: contacts }
   ```

3. **Records still holding `users/<id>` will report as dangling refs in `dt check`** once the field's
   `x-reference` is gone or retargeted. Rewrite or remove those values. If the field is a constant on a
   single-operator workspace, deleting it is the honest fix — `dt <collection> remove-field --name
   assignee` after you have removed the `x-reference`.

4. **`GET /api/info` no longer returns `user`.** Only a consumer that read that field is affected — a
   custom surface or a script, which should read `git config user.name` itself. The VS Code extension
   is **unaffected**: it has always computed the operator from git directly (`src/api.ts`), never from
   `/info`. Its `@me` expansion is now unreachable, because compile refuses a view that uses it.

`data/users/` is left on disk untouched — nothing deletes your files. Once nothing references it,
remove it yourself.

---

## 0.6.4 → 0.7.0

Adds namespaces, `collections rename`, and a test suite. **Nothing to migrate.**

### Required: nothing

Every collection you have today has no namespace prefix, which means it is already in the **default
namespace**. Same `storage.path`, same reference strings, same files on disk. `dt compile && dt check`
and you are done.

### ⚠ One hard constraint, and it points backwards

**An engine older than 0.7.0 cannot read a runtime that uses a namespace.** It silently omits that
collection — not an error, just absent from the tree, the API and `dt <c> list`. So once a workspace
declares a namespace and puts a collection in one, **every consumer of that workspace has to be on
0.7.0**: the CLI, the VS Code extension's pinned engine, and any script.

If two engines share one workspace (the self-shadowing dev-clone case, decision 24), sort that out
before declaring a namespace. Until you declare one, nothing changes and old engines stay fine.

### Optional: adopting a namespace

Declare it first — an undeclared prefix is a compile error, deliberately:

```json
"dreamteamer": { "namespaces": ["health", "finance", "work/clients"] }
```

Then either create a new collection in it, or move an existing one:

```bash
dt collections add --namespace health --name doctors     # new
dt collections rename doctors health/doctors             # existing: descriptor, records,
                                                         # filenames and refs, ONE commit
```

`health/doctors` stores records in `data/health/doctors/` and a record of it is referenced as
`health/doctors/dana-levi`. Nested namespaces work (`work/clients`), longest declared prefix wins.
`default` is a reserved namespace name.

Full reasoning, per-consumer radius and a verified version-skew table:
[`docs/namespaces-blast-radius.md`](docs/namespaces-blast-radius.md).

### Four things compile now REFUSES

All four were silent before. If you hit one on the first compile after upgrading, the message names
the fix — but here is why each exists:

| Refusal | Why it is not optional |
| --- | --- |
| A collection whose `storage.path` sits **inside** another's | Measured data loss: the outer collection indexed the inner one's records as its own, `check` reported the inner's fields as unknown fields of the outer, and a write through the outer could overwrite a record of the inner. |
| A slashed collection name whose prefix is not declared | It used to compile ✔ and then vanish from the runtime. |
| A namespace colliding with a collection name | Longest-match would pick one and make the other unreferenceable. |
| A malformed `id.pattern` | It used to surface as a raw `Invalid regular expression` from inside a write. |

**This is the one place an existing workspace can fail to compile after upgrading.** Only the first
row can hit a workspace that adopts no namespaces — and if it does, you had the data-loss bug.

### If you call the HTTP API

A collection name can now contain a slash, and `:name` is one path segment, so **percent-encode it**:

```
GET /api/collections/health%2Fdoctors/records
```

Unprefixed names are unaffected. An unencoded slash returns 404 rather than resolving to something
wrong.

### Also in this release

- `dt collections rename <old> <new>` (or `<old> --namespace <ns>`).
- `store.rm` on a **folder-shape** collection (`shape: folder`) can now be rolled back. Before this, a
  failed commit meant the deleted record was gone — `snapshot()` skipped directories.
- A caught git failure no longer prints git's raw error over the engine's own message.
- The generated orientation block in your `CLAUDE.md` / `AGENTS.md` carries the real engine version
  instead of a hardcoded `v0.6`, and states the namespace splitting rule when you declare namespaces.
  It is regenerated by `dt compile`.
- `npm test` exists: 218 assertions, ~8s, zero runtime dependencies. `npm run verify` is the
  pre-commit gate and CI now runs it.

---

## 0.6.3 → 0.6.4

Adds the module dependency graph and the `modules` collection.

### ⚠ Required for MODULES that reference another module's collections

Compile now **fails** if a collection's `x-reference` targets a collection the module neither owns nor
declares. If you maintain a module, declare the edges in its `package.json`:

```json
"dreamteamer": {
  "dependencies": ["crm"],          // HARD: this module cannot compile without crm
  "peerDependencies": ["contacts"]  // SOFT: works without it; references go unresolved
}
```

The error names which to add. The engine's own nine collections are an implicit dependency of every
module — you never declare those.

A workspace that only has its own collections needs nothing.

### `modules` is now a collection

Projected by compile from each module's `package.json` — nothing to seed, nothing to write. If you
happened to have your own collection named `modules`, rename it; the name is taken.

### Optional: title your module

The nav groups by owning module and derives a label from the id, so `crm` renders as "Crm". Set the
real one where only the module knows it:

```json
"dreamteamer": { "title": "CRM" }
```

`group:` on a collection is **deprecated** as a nav axis from this release. It is still read by
nothing and needs no removal.

---

## 0.6.2 → 0.6.3

**⚠ A behaviour change worth checking your scripts for.**

In the meta verbs, an empty value now **UNSETS** a key instead of writing an empty string:

```bash
dt ui-views set my-view options.provider=      # 0.6.2: wrote provider: ''
                                               # 0.6.3: removes the key
```

This matches what `store.set` has always done for top-level record fields. If a script of yours
relied on getting a literal `''`, write it explicitly. Nothing on disk changes until you run such a
command, so there is no data migration.

---

## 0.6.1 → 0.6.2

No action required.

- **compile stopped validating ui-view `layout` ids.** The allowlist mirrored the VS Code extension's
  component registry from a different repo and rejected layouts that worked (`kanban`, `calendar`,
  `map`, then `erd`, `graph`). An unregistered id now degrades to a table rather than failing the
  compile. If you added a `dreamteamer.studio.layouts` key to work around it, you can delete it — it
  is read by nothing.
- **`dt install` no longer abandons the whole restore** when one git module is unreachable. Rerun it
  after a failed restore and the rest come down.

---

## Older than 0.6.1

Upgrade straight to the latest, then `dt compile && dt check`. Read the **0.6.3 → 0.6.4** section
above if you maintain a module — the reference-declaration gate is the one change in this range that
can fail a compile.
