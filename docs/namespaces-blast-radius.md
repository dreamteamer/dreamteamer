# Namespaces — gaps found, blast radius, and what a consumer has to do

Written alongside the change that added declared namespaces. Its job is to be honest about what was
already broken, what every consumer has to do about it, and which claims here were *verified* rather
than reasoned.

## 1. Gaps that existed BEFORE this change

All four were found while scoping namespaces; none of them needed namespaces to be reachable. Each is
now a hard error or a fix, with a test.

| # | Gap | Symptom before | Where |
|---|---|---|---|
| 1 | **A collection whose `storage.path` is inside another's** | MEASURED data loss. Give A `data/health` and B `data/health/doctors`: A's recursive walk indexes B's records as its own, `dt A list` prints B's records under A's name, `check` reports B's fields as unknown fields of A, and a write through A can overwrite a record of B. `compile` reported ✔ throughout, because nothing ever compared two collections' paths. | `namespace.storageOverlaps`, called from `compile` |
| 2 | **A slashed collection name** | Compiled clean, wrote `.dreamteamer/collections/<ns>/<name>.collection.yaml`, then vanished: `loadDescriptors` read one directory level, so the collection was absent from the runtime while compile said ✔ and `dt <c> list` answered "unknown collection" for something that had just compiled. | `runtime.loadDescriptors` (now recursive) + `namespace.unqualifiedProblems` |
| 3 | **A malformed `id.pattern`** | `patternRe` throws, and it is called from `store.add` and `check` — so a typo surfaced as a raw `Invalid regular expression` from inside a write instead of a compile error naming the descriptor. | `compile`, beside the JSON-Schema gate |
| 4 | **`fileToRecord` (extension) matched the FIRST collection directory, not the longest** | The same open file resolved to different collections depending on descriptor enumeration order. The engine's `pathToRecord` has always done longest-prefix; the extension's copy never learned it. | `dreamteamer-vscode/src/fsdata.ts` |

Gap 2 is the one to learn from: it is the decision-156 shape again — a silent ✔ over work that did not
happen. It is why namespaces are *declared* rather than inferred, and why the declaration is enforced.

## 2. Gaps the namespace work introduced, and how they were closed

| Introduced | Closed by |
|---|---|
| `schema-ops` derives a descriptor's source path from its name, so `add-field` on `health/doctors` wrote `collections/health/doctors.collection.yaml` — which a flat readdir skipped while the verb reported ✔ | `compile` enumerates `collections/` **recursively** (every other kind stays flat: their ids are single segments) |
| `:name` is one path segment, so a slashed name would break 15 Express routes and the extension's `seg[]` router | Callers **percent-encode** the collection name. Verified against real Express 5: `/collections/health%2Fdoctors/records` matches `:name` and decodes to `health/doctors`, so no route changed. `*name` was rejected — a greedy wildcard, a literal and a second wildcard in one pattern has several readings |
| `extension.ts` built six URLs with a raw `${d.name}` | All six now `encodeURIComponent`. The webview's `adapter.ts` already did |
| A regex cannot find the collection/id boundary | `native.ts`'s `REF_RE` matches the whole slash-path and defers to `engine().parseRef` |

## 3. Blast radius by consumer

### `dreamteamer` (the engine)

One new `src/` module, `namespace.js`, in the **record** layer — pure, so the declared list arrives as
an argument and every rule is unit-testable without a workspace. `npm run layers` passes; **every
metrics budget still passes** (+142 code lines against a 3721 ceiling), so `metrics.json` is untouched.

Changed: `compile` (validate, derive `storage.path`, overlap gate, recursive `collections/`, manifest
key), `runtime` (recursive `loadDescriptors`, `namespaces()`), `store` + `check` (both parse through
`parseRef`), `schema-ops` + `collections-cli` + `cli` (the `--namespace` verb), `server` (a comment
stating the encoding contract — no route changed).

### `dreamteamer-vscode` (the UI)

Two real bugs fixed (gap 4 above, and `loadDescriptors` reading one level — the same bug as gap 2, in a
second copy that exists because the tree must draw before the engine finishes loading). `engine.ts`
gains `parseRef` and `namespaces`, tolerant of an older pinned engine. The nav axis moved from owning
module to namespace, and the decision moved out of `tree.ts` into `src/nav.ts` so it can be tested
without booting a window.

⚠ **`engine.ts`'s import list is a hand-maintained mirror of the engine's filenames.** `namespace.js`
and `runtime.js` are loaded **tolerantly** (`.catch(() => null)`), so this extension still activates
against an engine that has neither. Nothing was added to the non-tolerant `Promise.all`.

### Harness adapters (`.claude/`, Codex, Pi, Gemini, Cursor)

**No change needed.** They copy skills and agents verbatim and write prose that says references are
`<collection>/<id>`; nothing enumerates collection names. The namespace documentation added to
`skills/using-dreamteamer/references/records.md` and `skills/building-dreamteamer/references/collections.md`
propagates into every harness on the next `dt compile`, verified in a fixture.

### `recipes` modules (copied, not installed)

**No change needed, and none possible to force.** A recipes module ships unprefixed collections, which
are default-namespace collections and behave exactly as before. A module *cannot* declare a namespace —
`dreamteamer.namespaces` is read from the **workspace** package.json only, deliberately: a module that
could declare a namespace could move where another module's records live, and the whole point of a
namespace is that the workspace decides how its own data is partitioned. A workspace that wants a copied
module's collection namespaced renames it in its own copy, which is what copy-not-install is for.

## 4. Migration

**For an existing workspace: none.** Every collection that exists today has no prefix, is therefore
already in the default namespace, and is untouched — same `storage.path`, same reference strings, same
files on disk. Verified: declaring `namespaces: ["health"]` in a workspace whose only collection is
`tasks` leaves `data/tasks` and a clean `check`.

**To adopt a namespace** (three steps, and the order matters):

1. Declare it: `"dreamteamer": { "namespaces": ["health"] }`.
2. For a **new** collection: `dt schema add-collection --namespace health --name doctors`. For an
   **existing** one: `dt schema rename-collection doctors health/doctors` (or `doctors --namespace
   health`) — shipped in 0.9.0, it moves the descriptor, the records, the record filenames and every
   inbound reference in ONE commit. Before 0.9.0 there was no rename verb and this step was a six-step
   hand migration (`git mv` the descriptor, edit `name`/`storage.path`, `git mv` the record folder,
   rewrite every reference); that fallback is obsolete now.
3. `dt compile && dt check`.

Declaring the namespace **before** the collection compiles is not optional — an undeclared prefix is a
compile error, which is the whole point of gap 2.

## 5. Version skew — verified, not assumed

| Situation | Behaviour |
|---|---|
| **New engine, runtime compiled by an older one** (the normal state between `git pull` and `dt compile`) | `namespaces` reads as `[]`, the store loads, records read, unprefixed references parse. No throw. ✔ verified |
| **New engine, workspace declares nothing** | Identical to before in every respect. ✔ verified |
| **⚠ OLD engine, runtime compiled by this one, workspace USES a namespace** | The old engine's `loadDescriptors` reads one directory level, so the namespaced collection is **absent** — not corrupt, but silently missing, and `dt compile` on the old engine reproduces the same absence. ✔ verified |
| **Old engine, workspace declares no namespace** | Unaffected. |

So the one hard constraint: **a workspace that adopts a namespace requires every consumer of that
workspace — CLI, extension, any script — to be on a namespace-aware engine.** This is the same shape as
the pre-flatten note in CLAUDE.md, and reachable the same way: a shared workspace where two engines
disagree (the self-shadowing dev-clone case), or an extension pinned to an older engine. The extension
itself is safe either way because it loads `namespace.js` tolerantly; what is *not* safe is an old
**engine** compiling a namespaced workspace.

## 6. What is NOT covered

- **Tier 3 (the VS Code CDP smoke test) did not run.** `dreamteamer-vscode/scripts/launch.mjs` hardcodes
  `/Applications/Visual Studio Code.app/...`, so it is macOS-only and cannot execute in a Linux
  container. The UI layer was validated instead by driving `engine.ts`, `fsdata.ts` and `nav.ts` over a
  real compiled namespaced workspace — which is how both extension bugs were found — plus 20 tier-1
  assertions. **A human should still run `npm run test:ui` on a workstation** before shipping, because
  nothing cheaper proves the tree actually draws.
- **No `collections rename` verb — true when this was written, closed in 0.9.0.** Moving an existing
  collection into a namespace was a hand migration (step 2 above, before it was rewritten). `dt schema
  rename-collection` replaces that migration now; step 2 above reflects the current verb.
- **`ui-views` were not re-pointed.** A view targeting `collections/<name>` keeps working because the
  qualified name is just a record id in the `collections` collection — verified in a unit test — but no
  view was migrated, since none exist that reference a namespaced collection yet.
