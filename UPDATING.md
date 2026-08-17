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

### Pinning the engine from git instead of npm

A workspace does not have to wait for a release to land on npm. The engine has no build step — the
published tarball is the repo — so a git ref installs identically:

```bash
npm install "github:dreamteamer/dreamteamer#v0.7.0"     # a tag
npm install "github:dreamteamer/dreamteamer#35d68da"    # or an exact commit
```

Useful in three situations: taking a fix before it is tagged, pinning every workspace in a fleet to one
audited commit, and reproducing a bug against a specific engine. `dt status` prints which engine a
workspace actually resolved, which is the thing to check when two of them disagree.

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
