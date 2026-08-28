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

`recordResolver` split a reference at the first slash, so `family/people/gilad` asked the store for
the collection `family` — a namespace, not a collection. The read threw, the resolver returned null,
and `filter.js` treats an unresolvable ref as NARROWING. So this matched nothing, in silence:

```bash
dt list family/health/lab-results --where '{"person":{"name":{"_eq":"Gilad Khen"}}}'   # 0 rows
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
