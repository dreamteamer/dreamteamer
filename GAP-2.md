# Gap report 2: what is still open

[GAP.md](GAP.md) is the first report: 64 gaps found in the first 490 lines of this engine, with the evidence for each. Since then 34 were closed and 4 partly closed, and an independent review of that work found and fixed more. This second report is the distance that remains. It covers the engine at commit `396fa52` — 913 lines in `src/` and `bin/`, 33 tests — and every piece of evidence in it was run again on that commit.

It keeps the first report's ids, so an entry here can be read beside its original, and adds four gaps the first report did not have (`N1` to `N4`).

## How to read it

The labels are the first report's.

| Column | Meaning |
|---|---|
| **State** | **Missing**: no code. **Partial**: code that does less than intended. **Incompatible**: a different result from the released engine for the same input. **Unverified**: stated, not established |
| **Nature** | **Scope boundary**: deliberately not built yet. **Defect**: wrong by the engine's own intent, or by the compatibility it aims for. **Unverified claim**: not known either way |
| **Impact** | High, Medium or Low, for someone using the published modules |
| **Effort** | Low: up to half a day. Normal: one to three days. High: a week or more, or a decision is still open |
| **Size, lines** | A range of lines added or changed. **E** engine (`src/model`, `src/store`), **A** adapters (the CLI, compile, anything that presents or serves), **T** tests, **C** configuration |
| **Complexity** | Low: one function, behaviour not in doubt. Normal: several parts, behaviour known. High: correctness is hard to show, or the design is undecided |
| **Gain** | **S** safety, **C** compatibility with the released engine and its modules, **F** function a user lacks, **Q** quality |
| **Confidence** | In the size and effort: High, Medium or Low |

The first five columns are findings. **The rest are estimates**, made by reading the code; nothing in them has been built. Sizes are for the code as it is now written. A restructuring to the house style in [CLAUDE.md](CLAUDE.md) is under way, with one file per export and a formatter, and it will lengthen everything by a factor that is not yet known; the figures here will need the same factor.

How good were the last estimates? The first report estimated the set that was then built at 400 to 800 lines of code and 450 to 750 of tests. It took 544 added and 190 removed, and 391 of tests. The review fixes that followed added 68 lines of code and 94 of tests, which no estimate had foreseen. So: the ranges held for code, ran high for tests, and missed the cost of what a second reader finds.

`rel` is the released engine, dreamteamer 0.49.1, run in a workspace it created itself; `dtx` is this engine. Absolute paths are shortened to `…`.

## Where the engine stands

Measured on commit `396fa52`.

| | |
|---|---|
| Engine | 913 lines, against a budget of 7,000 |
| Tests | 33, in three suites: the API, the command line as a process, eight real published packages |
| A real workspace of 21 published packages, read-only | 22 of 22 modules, 54 of 54 collections, 4,837 records seen — every one stored under `data/` — and `check` reports no errors and no warnings, as the released engine does |
| A record written here | has the id, file name, timestamp and layout the released engine gives it; the released engine lists it under the same id |
| Still failing in the released engine's `check` after a write here | whatever this engine does not validate ([V3](#v3)); a stale reverse field ([D8](#d8)) no longer, since D8 closed |

## Summary

30 gaps from the first report are open or partly open, and 4 are new. By nature: 24 scope boundaries, 9 defects, 1 unverified claim.

| Id | Gap | State | Nature | Impact | Effort | Size, lines | Complexity | Gain | Shared | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|
| [D8](#d8) | Reverse fields are not maintained, and the released `check` then fails — **closed after this report**: maintained on `add`/`set`/`rm`, reported stale by `check`, repaired by `relations rebuild`; the released `check` gives 0 violations on records written here | Closed | Scope boundary | High | High | E 60–120 · T 50–80 | High | C · F | P1 | Medium |
| [V3](#v3) | Contents of objects and maps, uniqueness and cross-field rules are not enforced | Partial | Scope boundary | High | Normal | E 90–210 · T 50–90 | Normal | S · C | P2 | Medium |
| [N1](#n1) | Collections whose folders overlap read and delete each other's records | Partial | Defect | Medium | Low | E 15–30 · T 15–25 | Low | S | P2 | High |
| [A1](#a1) | Nothing delivers the instructions to an agent harness | Missing | Scope boundary | High | High | A 120–250 · T 60–120 | High | F | P3 | Low |
| [M4](#m4) | Commands, agents, bindings, views, navigation and scripts are not read | Missing | Scope boundary | High | High | E 40–80 to read them; using them is A1, D13 and U1 | High | F | P3 · P7 | Low |
| [A5](#a5) | Nothing reports stale instructions | Missing | Scope boundary | Low | Normal | A 25–50 · T 15–25 | Normal | Q | P3 | Medium |
| [G1](#g1) | No `commit`, `changes`, `history`, `diff` or `revert` | Missing | Scope boundary | Medium | Normal | A 100–200 · T 50–90 | Normal | F | P4 | Medium |
| [D13](#d13) | Twenty-six released verbs have no counterpart | Missing | Scope boundary | High | High | A 600–1,400 for all; per verb below | High | F · C | P1 · P4 · P7 | Low |
| [D12](#d12) | `list` has no sort; `get` prints a shape of its own | Partial | Defect | Low | Low | A 20–40 · T 15–25 | Low | C | — | High |
| [R4](#r4) | `created` is not derived for a record that has none | Partial | Defect | Low | Low | E 10–25 · T 10–20 | Low | C | P4 | Medium |
| [M7](#m7) | `disable` means something else here | Incompatible | Defect | Medium | Low | E 15–30 · T 15–25 | Low | C | P5 | Medium |
| [R3](#r3) | Composition differs at the edges | Incompatible | Defect | Medium | Normal | E 45–75 · T 40–60 | Normal | C | P5 | Medium |
| [M9](#m9) | The module contract is not enforced | Missing | Scope boundary | Medium | Normal | E 50–80 · T 40–60 | Normal | C | P5 | Medium |
| [M8](#m8) | No record layers, git-delivered modules, classic layout or `data_path` | Missing | Scope boundary | Medium | High | E 100–200 · T 60–110 | High | C | P5 | Low |
| [R1](#r1) | Display metadata and other descriptor keys are dropped — **closed after this report**: `display`, `title`, `record_title`, `internal`, `sensitive` and `constraints` are carried in the model, merged with mixins and overlays as the released engine merges them | Closed | Scope boundary | High | Low | E 5–15 · T 5–10 | Low | F, once U1 exists | P7 | High |
| [D10](#d10) | System collections are not records — **partly closed after this report**: the engine ships the system module, references to source records resolve, `list` and `get` answer for them, writes are refused; nothing is projected to disk yet | Partial | Scope boundary | Medium | Normal | E 40–80 · T 20–40 | Normal | C · F | P7 | Medium |
| [D11](#d11) | Binary records are refused; owner-folder storage is ignored | Missing | Scope boundary | Medium | High | E 100–200 · T 60–100 | Normal | C | — | Low |
| [M1](#m1) | Nothing installs a module's dependencies or a preset's members | Missing | Scope boundary | High | High | A 80–150 · T 50–100 | High | F · C | P6 | Low |
| [S2](#s2) | No `init`, `install`, `update`, `status`, `doctor` or `setup` | Missing | Scope boundary | Medium | High | A 150–350 · T 80–150 | High | F | P6 | Low |
| [L1](#l1) | Engine floors and peer versions are ignored | Missing | Scope boundary | Medium | Normal | E 30–50 · T 20–30 | Normal | C · S | P6 | Medium |
| [L2](#l2) | No upgrade path, and orphaned records go unreported | Missing | Scope boundary | High | High | E 15–25 for a warning; A 150–400 for updates | High | F | P6 | Low |
| [S1](#s1) | Cannot be installed as a package, and takes over `dt` if it is | Missing | Scope boundary | Medium | Normal | C 20–50 | Normal | F | P6 | Medium |
| [M5](#m5) | Extensions contribute nothing | Missing | Scope boundary | High | High | A 150–400 · T 80–150 | High | F · C | P7 | Low |
| [V5](#v5) | None of the checks that extensions and the released engine add | Missing | Scope boundary | Medium | Normal | E 30–60 for the engine's own; the rest is M5 | Normal | C | P1 · P7 | Low |
| [U1](#u1) | No UI, and nothing to draw one from | Missing | Scope boundary | High | High | A 300–800 · T 100–200 | High | F | P7 | Low |
| [U2](#u2) | No live refresh | Missing | Scope boundary | Low | Normal | A 40–80 · T 20–40 | Normal | F | P7 | Low |
| [F5](#f5) | Several writers on one record: conflicts are refused, and a few updates may be lost | Partial | Defect | Medium | High | E 20–50 · T 30–60 | High | S | P8 | Low |
| [F6](#f6) | The stale-write check has two open windows and no test | Partial | Defect | Medium | Normal | T 15–25; the fix is F5 | High | S | P8 | Low |
| [F4](#f4) | A collection folder that is a symbolic link is followed | Partial | Scope boundary | Low | Low | none: a decision | Low | S | — | High |
| [N2](#n2) | A changed line loses its inline comment; Windows line endings come out mixed | Partial | Defect | Low | Low | E 10–25 · T 10–15 | Low | Q | — | Medium |
| [N3](#n3) | The house style is not applied, and a module's manifest is read without checks | Partial | Scope boundary | Medium | Normal | a refactor of all 913 lines, in progress | Normal | Q | — | Medium |
| [N4](#n4) | A few inputs are stored or reported as typed where the released engine normalises them | Incompatible | Defect | Low | Low | A 10–25 · T 10–15 | Low | C | — | Medium |
| [S4](#s4) | The Node floor is declared, not measured | Unverified | Unverified claim | Low | Low | C 20–40 | Low | Q | P6 | High |
| [T3](#t3) | The API is a fraction of the released one | Missing | Scope boundary | Medium | — | none of its own: it grows with what is built | — | F | — | — |

`D13` verb by verb: `rename` E 50–90, and it needs the reference scan that already exists for `rm`; `resolve` A 20–35; `values` A 10–15; `reorder` E 30–50; `exports` A 60–100; `next` A 80–150, and it needs the command bindings of M4; the six schema verbs A 300–700 together. `commit`, `changes`, `history`, `diff` and `revert` are G1; `relations` is D8; `init`, `install`, `update`, `setup`, `doctor` and `status` are S2.

### Shared work

| Package | Closes | Size together | Effort | What is shared |
|---|---|---|---|---|
| **P1** Relations | D8, the stale-field part of V5, `relations` and `rename` from D13 | E 110–210 · T 80–120 | High | One description of which field is the reverse of which. Writes use it to update the other record, `check` to say what is stale, `rename` to rewrite references |
| **P2** What a descriptor says | V3 N1 | E 100–230 · T 60–110 | Normal | Nested fields of an object, the value type of a map, uniqueness (a scan of the collection, as `rm` already does for references), and cross-field rules, which are a small evaluator of `if`, `then`, `required`, `const` and `enum`. Overlapping folders are caught when the model is built |
| **P3** Agent delivery | A1 A5, and the commands, agents and skills of M4 | A 180–330 · T 80–140 | High | Reading commands and agents; writing each harness's files; a stamp that says what the files were made from |
| **P4** Git verbs | G1 R4, and five verbs of D13 | A 110–220 · T 60–100 | Normal | The first code here that runs another program; `created` derived from the first commit |
| **P5** Arrangements and the contract | M7 M8 M9 R3 | E 180–330 · T 130–210 | High | Many small rules, each needing a fixture; record layers are the largest part |
| **P6** Install, lifecycle, distribution | M1 S2 L1 L2 S1 S4 | A 320–700 · T 170–330 | High | Driving npm; version floors; a build or published JavaScript. Mostly undecided |
| **P7** Extensions and a UI | M5 U1 U2 D10 R1, the rest of M4 and V5, `next` | A 600–1,600 · T 200–400 | High | The API that published extensions call, and a host for the existing UI package. The least certain figures here |
| **P8** Concurrency | F5 F6 | E 20–50 · T 45–85 | High | A retry on conflict and an exclusive create; a test that makes the check fire |

## Recommendations

This section is a proposal. Its sizes are the estimates above, with shared work counted once. The engine has 913 lines and a budget of 7,000.

### The next sweet spot: an engine an agent can use every day beside the released one

**Build P1, P2, P3 and P4, with the small items D12, M7, N2 and N4.** Eight pieces of work; two are rated High.

| Piece | Gaps | Why now |
|---|---|---|
| P1 Relations | D8, part of V5, `relations`, `rename` | It is the last thing that makes the released engine's `check` fail on a record written here, and 69 published fields depend on it |
| P2 What a descriptor says | V3 N1 | After it, what passes here passes there. N1 is the one remaining way to delete a record that others reference |
| P3 Agent delivery | A1 A5, part of M4 | The point of DreamTeamer is that the schema reaches the conversation. Today a person has to carry it there |
| P4 Git verbs | G1 R4 | `commit` scoped to the records a session wrote is how several agents share one workspace without sweeping up each other's work |
| `resolve` and `values` from D13 | part of D13 | Published skills call them, and they are small |
| D12, M7, N2, N4 | | Each is under forty lines and removes a difference a user would trip over |

**What it costs.** About 550 to 1,150 lines of engine and adapter code and 350 to 600 lines of tests, before the factor the restructuring adds. The engine would then be roughly 1,500 to 2,100 lines in today's style.

**What users could then do.**

- Run this engine and the released one on the same workspace, each passing the other's `check`.
- Open an agent session in a workspace and have it already know the schema, the skills and the commands.
- Commit exactly the records a session wrote, and see what changed.
- Rename a record without breaking the references to it.

**What would still be unavailable.** Installing and upgrading modules through the engine; extensions and their verbs; a UI; the schema verbs; binary records; record layers.

**Decisions it needs, and the answer assumed if nobody objects.**

1. **Reverse fields are stored, as the released engine stores them.** That gives up "one command writes one file": a write to a task also rewrites the user it is assigned to. The alternative, deriving them when a record is read, keeps writes simple and makes this engine's files differ from the released engine's, which defeats the purpose of P1.
2. **Harness files are written as the released engine writes them**: a marked block in the root instruction files, and skills, commands and agents copied into each harness's own folder. The engine then writes outside `.dt/` for the first time, and only where the workspace's `harnesses` setting names a harness.
3. **`commit` runs git.** It is the first time this engine starts another program. It stays explicit: nothing else commits.

**Risks and the least certain estimates.**

- **P3 is the least certain.** Five harnesses have five conventions, and no harness has been run against this engine yet; what is written has to be checked by loading it in one.
- **P1 touches two files per write**, so a crash between them leaves a stale reverse field. `check` must say so and `relations` must repair it; that pair is the safety net, and it has to exist before writes start maintaining anything.
- **Cross-field rules in P2** are written by modules as JSON Schema. The evaluator covers the keywords the five published collections use; a module that uses others would be refused, not half-enforced.

### Two other options

| | Only agreement with the released engine | The next sweet spot | Everything a module ships |
|---|---|---|---|
| **Includes** | P1 without `rename`; P2 | P1 P2 P3 P4, `resolve`, `values`, D12 M7 N2 N4 | The sweet spot, then P5, P6, P7 and the schema verbs |
| **Code added** | 160–350 lines | 550–1,150 lines | 2,200–4,900 lines |
| **Engine afterwards**, in today's style | about 1,050–1,250 lines | about 1,500–2,100 lines | about 3,100–5,800 lines |
| **Hardest piece** | P1 | P3 | P7: the API that extensions call, and a UI host |
| **A user can** | Share a workspace between the two engines | Also work with an agent that already knows the schema, and commit by record | Also install modules, run extensions and see the workspace |
| **A user still cannot** | Have instructions delivered; commit through the engine | Install or upgrade modules; run extensions; see a UI | — |

**Where the budget binds.** In today's style the third column fits under 7,000 lines. The restructuring will lengthen the code by a factor not yet known. If it is 1.5, the sweet spot comes to roughly 2,200 to 3,100 lines and remains comfortable, and the third column to roughly 4,700 to 8,700, which fits only in the lower part of its range. So the budget does not decide the next step, and it may force a choice later: of installing through the engine (P6), extensions (M5) and a UI (U1), not all three can be had in full. The cheapest way to keep all three in reach is to keep each thin: follow dependencies at discovery instead of driving npm, load an extension's checks and verbs without reproducing the released API name for name, and serve `model.json` to the existing UI package before writing any UI code here.

## The open gaps

Each entry says what happens today, with evidence from commit `396fa52`. Where the first report has more, the entry points to it.

<a id="d8"></a>
### D8 · Reverse fields are not maintained, and the released `check` then fails

`@dreamteamer/tasks` gives `users` a `tasks` field, the reverse of `tasks.assignee`. This engine neither fills nor checks such fields.

```
$ dtx add users "Dana Oren" && dtx add tasks "Call the bank" --assignee dana-oren
$ rel check
✖ data/users/dana-oren.user.md
    tasks: stale — run: dreamteamer relations rebuild users
1 violation. files were NOT modified.
$ dtx get users/dana-oren | grep -c tasks
0
```

**Impact:** every write here that sets a reference with a reverse side leaves the released engine's `check` red. 69 published fields are such reverse sides.

<a id="v3"></a>
### V3 · Contents of objects and maps, uniqueness and cross-field rules are not enforced

Formats, bounds and soft references are now enforced. These are not:

```
# shops: constraints say a chain must have branches; code is unique; address.zip is five digits; hours maps to integers
$ dtx add shops "Corner shop" --kind chain --code A1 --address '{zip: abc, planet: Mars}' --hours '{mon: early}'
✔ shops/corner-shop · …/data/shops/corner-shop.shop.md
$ dtx add shops "Other shop" --code A1
✔ shops/other-shop · …/data/shops/other-shop.shop.md
$ dtx check | tail -1
2 records · 4 collections · 3 modules · 0 errors · 0 warnings
```

Across the published descriptors: `constraints` in 5 collections, nested `fields` on 12 objects, `values` on 2 maps, `unique` on 2 fields.

**Impact:** a record that breaks a module's own rule is written, passes here, and fails the released `check`.

<a id="n1"></a>
### N1 · Collections whose folders overlap read and delete each other's records

New. Nothing stops a descriptor from storing its collection in a folder that contains another's. Its `list` then returns the other's records, and its `rm` deletes them without the check for references, because the reference is spelled through the wrong collection.

```
# everything: storage { path: data, suffix: user }
$ dtx list everything
users/dana-oren
$ dtx rm everything/users/dana-oren
✔ removed everything/users/dana-oren
$ dtx check
✖ tasks/2026-11-17--call: assignee: broken reference users/dana-oren
```

**Impact:** needs a careless or hostile descriptor, and then it is the one remaining way to delete a record that others reference. The released engine refuses overlapping storage when it compiles.

<a id="a1"></a>
### A1 · Nothing delivers the instructions to an agent harness

`compile` writes `.dt/AGENTS.md`, `.dt/model.json` and `.dt/.gitignore`, and nothing else. After it the workspace's top level is unchanged. The file now carries enough to work from — the command to run, every field of every collection, each skill's path — and a person still has to point the agent at it. See [GAP.md](GAP.md#a1) for what the released engine writes for each harness.

**Impact:** the schema does not reach a conversation by itself.

<a id="m4"></a>
### M4 · Commands, agents, bindings, views, navigation and scripts are not read

Unchanged. Across 21 published packages: 30 commands, 43 command bindings, 27 UI views, 19 scripts, 3 agents and 2 navigation documents are not read. Collections (67 descriptors), mixins (2) and skills (21) are.

<a id="a5"></a>
### A5 · Nothing reports stale instructions

```
$ dtx compile                     # then add a required field `owner` to shops
$ dtx check | grep -c 'owner: required'
2
$ grep -c owner .dt/AGENTS.md
3                                 # other collections' owner fields; shops is unchanged
```

Validation follows a descriptor at once; the instruction file waits for the next `compile`, and nothing says so.

<a id="g1"></a>
### G1 · No `commit`, `changes`, `history`, `diff` or `revert`

Unchanged, and deliberate so far: nothing in `src/` starts another program. Each of these verbs prints the usage line and exits 2.

<a id="d13"></a>
### D13 · Twenty-six released verbs have no counterpart

```
$ for v in rename resolve values next history commit changes relations; do dtx $v x; echo $?; done
2 2 2 2 2 2 2 2
```

The verbs here are `modules`, `collections`, `list`, `get`, `add`, `set`, `rm`, `check`, `compile`, `help`. The table in [GAP.md](GAP.md#d13) lists the released engine's.

<a id="d12"></a>
### D12 · `list` has no sort; `get` prints a shape of its own

`list` now filters, prints JSON on request and refuses a flag it does not know:

```
$ dtx list shops --sort name
✖ list does not take --sort — it takes --filter, --json
```

`get` prints JSON where the released engine prints YAML, and `--json` wraps the fields as `{ref, collection, id, path, data, mtimeMs}` where the released engine prints them flat with `id`, `$file` and `$repo`.

<a id="r4"></a>
### R4 · `created` is not derived for a record that has none

`updated` is now refused unless declared, and `created` must be a date and time. A hand-written record with no `created` still reads back without one; the released engine derives it from the id's date or the first commit. By reading the code: `get` returns what the file holds and nothing more.

<a id="m7"></a>
### M7 · `disable` means something else here

```
"disable": ["modules/@dreamteamer/tasks"]
$ rel compile      compiled 12 collections        # tasks dropped
$ dtx collections | wc -l      13                  # still there
```

<a id="r3"></a>
### R3 · Composition differs at the edges

Unchanged, and not re-run: the order of fields (6 of 54 published collections), which of a local and an npm overlay wins, an overlay's keys other than `fields`, how a mixin's storage and id rule merge with the collection's own, and silent merging where the released engine reports a conflict. See [GAP.md](GAP.md#r3).

<a id="m9"></a>
### M9 · The module contract is not enforced

An unknown type is now an error. An undeclared namespace still is not:

```
# a local collection named lab/samples, no namespace declared
$ rel compile    ✖ compile error: collection "lab/samples" is namespaced, but "lab" is not declared …
$ dtx check      0 records · 14 collections · 4 modules · 0 errors · 1 warnings
```

Nor is an unknown manifest key, a reference to a collection the module neither owns nor declares, or an overlay from a module that does not depend on the collection's owner.

<a id="m8"></a>
### M8 · No record layers, git-delivered modules, classic layout or `data_path`

`check` now says when it meets a `data_path` or `git_modules` setting it does not honour:

```
$ dtx check
⚠ package.json: dreamteamer.data_path "records" is not honoured — records are stored where each descriptor says
```

The settings themselves are still not honoured. See [GAP.md](GAP.md#m8) for the five arrangements.

<a id="r1"></a>
### R1 · Display metadata and other descriptor keys are dropped

Unchanged: `display`, `record_title`, `internal`, `constraints`, `sensitive` and `title` are not carried in the model. An authored `singular` now is.

<a id="d10"></a>
### D10 · System collections are not records

Unchanged: the 202 records the released engine projects for its eight system collections (skills, collections, modules and so on) do not exist here. `dtx modules` and `dtx collections` print two of them in a format of their own.

<a id="d11"></a>
### D11 · Binary records are refused; owner-folder storage is ignored

```
$ dtx list assets
✖ assets: binary storage is not supported by this experiment
$ dtx check
⚠ assets: binary storage is not supported — its files are not checked
```

`check` now says what it skipped. A reference to a binary record is checked for a file of that name. `storage.under` is still ignored; no published collection uses it.

<a id="m1"></a>
### M1 · Nothing installs a module's dependencies or a preset's members

The message is now accurate and gives the fix; the work is still the user's.

```
$ npm install --save-exact @dreamteamer/tasks@0.3.4 && dtx check
✖ @dreamteamer/tasks: depends on module @dreamteamer/users, which is in node_modules but not listed in this workspace's package.json — npm install --save-exact @dreamteamer/users
$ npm install --save-exact @dreamteamer/core@0.13.1 && dtx modules
@dreamteamer/core@0.13.1 [npm] — not acted on here: nav, preset, engine
$ ls node_modules/@dreamteamer
core tasks users
```

<a id="s2"></a>
### S2 · No `init`, `install`, `update`, `status`, `doctor` or `setup`

Unchanged. A workspace is made with `git init`, `npm init` and `npm install`.

<a id="l1"></a>
### L1 · Engine floors and peer versions are ignored

`modules` now says that it sees an engine floor and does not act on it.

```
$ dtx modules | grep future            # a module that asks for engine >=99.0.0
@northwind/future@1.0.0 [npm] — not acted on here: engine
$ dtx add gadgets "Pocket lamp"
✔ gadgets/pocket-lamp · …
```

<a id="l2"></a>
### L2 · No upgrade path, and orphaned records go unreported

```
$ mkdir -p data/people && printf -- '---\nname: Ana\n---\n' > data/people/ana.person.md
$ dtx check
1 records · 3 collections · 3 modules · 0 errors · 0 warnings
```

A folder of records that no installed collection reads is not mentioned. The released engine warns about it.

<a id="s1"></a>
### S1 · Cannot be installed as a package, and takes over `dt` if it is

```
$ npm pack <checkout> && npm install ./dreamteamer-first-principles-0.0.0.tgz && npx dt
… ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING …
```

Node will not run TypeScript from inside `node_modules`, and the house style rules out a build for running the engine. Publishing needs one of the two to give.

<a id="m5"></a>
### M5 · Extensions contribute nothing

Unchanged. Five of the 21 packages declare an extension; none is loaded. See [GAP.md](GAP.md#m5).

<a id="v5"></a>
### V5 · None of the checks that extensions and the released engine add

Unchanged for extension rules and for stale reverse fields. Unrecognised files, which the first report listed here, are now reported.

<a id="u1"></a>
### U1 · No UI, and nothing to draw one from

Unchanged.

<a id="u2"></a>
### U2 · No live refresh

Unchanged.

<a id="f5"></a>
### F5 · Several writers on one record: conflicts are refused, and a few updates may be lost

Thirty `set` commands at once on one record, each setting a different field, three runs:

```
run 1: exit 0: 15 of 30 · refused: 15 · values in the file: 15 · lost: 0
run 2: exit 0: 18 of 30 · refused: 12 · values in the file: 18 · lost: 0
run 3: exit 0: 19 of 30 · refused: 11 · values in the file: 19 · lost: 0
```

No update was lost in these runs; 9 of 195 were in the runs behind the first report. The mechanism has not changed, so the difference is in timing, not in a fix: more writers are refused now, and the window in which one can be lost is still there.

<a id="f6"></a>
### F6 · The stale-write check has two open windows and no test

Unchanged; see [GAP.md](GAP.md#f6).

<a id="f4"></a>
### F4 · A collection folder that is a symbolic link is followed

A link below a collection's folder is no longer followed, and a storage path outside the workspace is no longer read or written. A collection's folder that is itself a link still is, as in the released engine. Whether to keep that is a decision, not work.

<a id="n2"></a>
### N2 · A changed line loses its inline comment; Windows line endings come out mixed

New. `set` keeps comments between keys. A comment on the same line as a key it changes goes with the old line, and in a file with Windows line endings the lines it writes end differently from the ones it leaves.

```
$ printf -- '---\r\nname: Sam\r\nkind: human   # checked\r\n---\r\n' > data/users/sam.user.md
$ dtx set users/sam kind=agent && od -c data/users/sam.user.md
   -   -   -  \n   n   a   m   e   :       S   a   m  \r  \n   k   i   n   d   :       a   g   e   n   t  \n   -   -   -  \n
```

<a id="n3"></a>
### N3 · The house style is not applied, and a module's manifest is read without checks

New. [CLAUDE.md](CLAUDE.md) sets rules this code does not yet follow: one file per export, no re-exporting file, a linter and a formatter, readers in place of casts for everything read from disk. Seven uses of `any` remain where a `package.json` or a descriptor enters. A refactoring that changes no behaviour is in progress.

<a id="n4"></a>
### N4 · A few inputs are stored or reported as typed where the released engine normalises them

New, from the review. A date and time written with a space or with `+02` is accepted and stored as typed, where the released engine rewrites it in one form. A name too long for a file is refused with the operating system's message. `add` on a collection whose id rule needs a field the collection does not have names that field.

<a id="s4"></a>
### S4 · The Node floor is declared, not measured

Unchanged: `package.json` says 23.6 or later; it runs on 22.23 and 25.4 on macOS, and nowhere else has been tried.

<a id="t3"></a>
### T3 · The API is a fraction of the released one

It now exports 17 names against the released engine's 131, and grows with what is built.
