# Gap report: DreamTeamer First Principles

[README.md](README.md) says how this version is meant to work. This file measures the distance between that and the code on this branch. It lists what is missing, partial, incompatible or unverified, with evidence you can re-run and what each gap costs. It does not argue for or against the experiment.

## How to read it

Each gap has an id, what the README says, what actually happens, the evidence, the impact, and two labels.

| State | Meaning |
|---|---|
| **Missing** | There is no code for it. The README labels it Planned or Open, or the released engine has it |
| **Partial** | There is code, and it does less than the README's description of the intent |
| **Incompatible** | It works, with a different observable result from the released engine or its modules for the same input |
| **Unverified** | The README states it; no test and no recorded run establishes it |
| **Closed**, **Partly closed** | Fixed since the gap was found. The entry keeps its original evidence and opens with what closed it |

| Nature | Meaning |
|---|---|
| **Scope boundary** | A deliberate limit of this cut: something not built, which the README labels Planned, Open or Partial |
| **Defect** | The code does something wrong by its own intent, or by the compatibility the README aims for: a crash, a wrong or different result, a misleading message, lost content |
| **Unverified claim** | Not known either way |

### Where the evidence comes from

- **The code**: branch `experiment/first-principles-ts`, 490 lines in `src/` and `bin/`. References look like `src/store.ts:112`.
- **The test suite**: when the gaps were found, 5 tests; now 26, all passing. `npm run typecheck` is clean.
- **The walkthrough workspace**: what the README walkthrough builds — `@dreamteamer/tasks` 0.3.4, `@dreamteamer/users` 0.3.0 and the local module `home`. `dtx` is the shell function from the README. Commands marked `$` with no other setup run there, each on a fresh copy.
- **The side-by-side workspace**: one made by the released engine, with `npx dreamteamer@0.49.1 init` followed by `npx dreamteamer install @dreamteamer/tasks`. Both engines run in it: `rel` stands for `npx dreamteamer`, and `dtx` is run in the same folder. For writes each engine got its own copy. The released engine begins its output with the workspace's name, which is `R` here.
- **A real workspace**, private, cited as numbers only: 21 published packages and one local module, 54 collections, 5,038 records as the released engine counts them.
- **A side-by-side review**: five investigators ran both engines over larger matrices than fit here — 73 invalid writes, 49 damaged files, 30 parallel writers, 60 kills. Where an entry says "in the review", the figure or the case comes from there and was not re-run for this report; everything quoted as command output was.

Everything was run on Node 25.4.0, npm 11.7.0 and macOS, with yaml 2.9.1 and TypeScript 7.0.2, on 17 November 2026. Absolute paths are shortened to `…`.

## What has changed since the report was written

The report was written against commit `a029976`, the first 490 lines. Commit `143c57a` then built the set of fixes that [Recommendations](#recommendations) calls the sweet spot. Entries are kept as they were found, so the evidence still shows what was wrong; a closed entry opens with a line saying what closed it, and its README quotation is from the README of that time.

| | When found | Now |
|---|---|---|
| Gaps open | 64 | 26, and 4 partly closed |
| Engine, `src/` and `bin/` | 490 lines | 2,030 lines; 913 just before the restructuring below |
| Tests | 5, in 71 lines | 26, in 421 lines, three suites |
| Coverage | 98% of lines, 64% of branches, the CLI untested | 99% of lines, 86% of branches, the CLI included |
| Real workspace, records seen | 4,705 of 5,038 | 4,837 of 5,039: all but the system collections |
| Real workspace, `check` | 11 errors | no errors and no warnings, the released engine's verdict |
| A record written here, in the released engine | read; one case tried | read, listed under the same id, same file layout |

The estimate for this set was 400 to 800 lines of code and 450 to 750 of tests. It took 544 lines added and 190 removed in `src/` and `bin/`, and 391 added and 43 removed in `test/`.

The code was then restructured to the house style in [CLAUDE.md](CLAUDE.md), with no change in behaviour: TypeScript 6.0 instead of 7 as the type-checker, with `verbatimModuleSyntax`; ESLint with typescript-eslint's type-aware rules and Prettier added; one export per file, in folders under `src/`; and every input from disk read through typed readers instead of casts. The engine is now 2,030 lines: Prettier's line breaks alone take the same code from 913 lines to about 1,470, and one import per line adds about 250 more.

## The short version

**What holds.** On the real workspace this version finds the same 22 modules as the released engine, resolves the same 54 collections field for field (940 of 940 fields), sees every record stored under `data/`, and reaches the same verdict in `check`: no errors. For the records compared it reads the same stored values. It writes a record under the id, file name, timestamp and layout the released engine gives it. An invalid write is refused before anything reaches disk. A reference or an id cannot reach anything but a record of the collection it names. Text typed on the command line is stored as typed. It never runs git and needs no compile step.

**What was closed in `143c57a`.** Every defect that could delete, erase or expose content: references and ids that climbed out of a record ([F1](#f1), [F2](#f2), [F3](#f3)), values silently erased or cut short ([C2](#c2)), and deletes that broke or took other records ([D9](#d9)). Also the wrong file names ([D1](#d1)), the id rules ([D2](#d2), [D3](#d3), [D4](#d4)), absent peers ([M6](#m6)), silent typos ([R2](#r2)), impossible dates ([V2](#v2)), the unfiltered list ([D12](#d12)) and the whole-file rewrite ([D7](#d7)).

**What can still go wrong.**

- A write here that sets a reference with a generated reverse side leaves the released engine's `check` failing, because that side is not maintained ([D8](#d8)). 69 published fields are such reverse sides. This is the first thing to build next.
- A few updates are lost when several writers change one record at the same moment, and still report success ([F5](#f5), [F6](#f6)).
- A record that breaks a cross-field rule or a uniqueness rule passes here and fails in the released engine ([V3](#v3)).
- Each engine ignores the other's `disable` list ([M7](#m7)).

**What is simply not built.** Delivery of instructions to an agent harness ([A1](#a1)); commands, bindings, views and navigation ([M4](#m4)); extensions ([M5](#m5)); 26 of the released engine's 33 verbs, among them `commit`, `rename`, `next` and `install` ([D13](#d13)); binary records ([D11](#d11)); a UI ([U1](#u1)); any upgrade path ([L2](#l2)).

## Summary

64 gaps were found: 28 scope boundaries, 35 defects and 1 unverified claim. 34 are now closed and 4 partly closed; 26 are open, of which 21 are scope boundaries, 4 are defects ([M7](#m7), [R3](#r3), [F5](#f5), [F6](#f6)) and 1 is an unverified claim ([S4](#s4)). Among the open ones 20 are missing, 2 partial, 3 incompatible and 1 unverified.

The first five columns are findings, each backed by the entry it links to. **The last six are estimates** of what closing the gap would take: nothing in them has been built or measured. [How the estimates were made](#how-the-estimates-were-made) gives the scales, the assumptions and the uncertainty; [Shared work](#shared-work) says which gaps share code, so that sizes are not added twice; and [Recommendations](#recommendations) proposes which gaps to close.

| Id | Gap | State | Nature | Impact | Effort | Size, lines | Complexity | Gain | Shared | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|
| [S1](#s1) | Cannot be installed as a package, and takes over `dt` if it is | Missing | Scope boundary | Medium | Normal | C 20–50 | Normal | F | W12 | Medium |
| [S2](#s2) | No `init`, `install`, `update`, `status`, `doctor` or `setup` | Missing | Scope boundary | Medium | High | A 150–350 · T 80–150 | High | F | W11 | Low |
| [S3](#s3) | A folder that is not a workspace is accepted, or crashes | Closed | Defect | Medium | Low | A 5–15 · T 10–20 | Low | S · Q | W2 | High |
| [S4](#s4) | The Node floor is declared, not measured | Unverified | Unverified claim | Low | Low | C 20–40 | Low | Q | W12 | High |
| [S5](#s5) | No licence | Closed | Scope boundary | Low | Low | none: a decision and a file | Low | Q | W12 | High |
| [M1](#m1) | Nothing installs a module's dependencies or a preset's members | Missing | Scope boundary | High | High | A 80–150 · T 50–100 | High | F · C | W11 | Low |
| [M2](#m2) | A broken model stops nothing | Closed | Defect | High | Low | A 8–20 · T 10–20 | Low | S · Q | W5 | High |
| [M3](#m3) | Manifest keys and workspace settings are ignored without a word | Closed | Defect | Medium | Low | E 3–10 · T 5–10 | Low | Q | W5 | High |
| [M4](#m4) | Commands, agents, bindings, views, navigation and scripts are not read | Missing | Scope boundary | High | High | E 40–80 to read them; using them is A1, D13 and U1 | High | F | W8 · W13 | Low |
| [M5](#m5) | Extensions contribute nothing | Missing | Scope boundary | High | High | A 150–400 · T 80–150 | High | F · C | W13 | Low |
| [M6](#m6) | An absent optional peer makes records uneditable | Closed | Defect | High | Normal | E 20–40 · T 20–30 | Normal | C | W5 | Medium |
| [M7](#m7) | `disable` means something else here | Incompatible | Defect | Medium | Low | E 15–30 · T 15–25 | Low | C | W10 | Medium |
| [M8](#m8) | No record layers, git-delivered modules, classic layout or `data_path` | Missing | Scope boundary | Medium | High | E 100–200 · T 60–110 | High | C | W10 | Low |
| [M9](#m9) | The module contract is not enforced | Missing | Scope boundary | Medium | Normal | E 50–80 · T 40–60 | Normal | C | W10 | Medium |
| [R1](#r1) | Display metadata and other descriptor keys are dropped | Missing | Scope boundary | High | Low | E 5–15 · T 5–10 | Low | F, once U1 exists | W13 | High |
| [R2](#r2) | A typo in a descriptor is accepted, and can remove a field | Closed | Defect | High | Low | E 15–30 · T 15–25 | Low | S · C | W5 | High |
| [R3](#r3) | Composition differs at the edges | Incompatible | Defect | Medium | Normal | E 45–75 · T 40–60 | Normal | C | W10 | Medium |
| [R4](#r4) | The fields the engine adds itself differ | Partly closed | Defect | Medium | Low | E 10–25 · T 10–20 | Low | C | W7 | Medium |
| [D1](#d1) | Wrong file suffix for plurals that do not end in a plain "s" | Closed | Defect | High | Low | E 20–35 · T 15–25 | Low | C | W3 | High |
| [D2](#d2) | Id rules that published modules use are not understood | Closed | Defect | High | Normal | E 30–60 · T 30–50 | Normal | C · F | W4 | Medium |
| [D3](#d3) | Ids made from names differ | Closed | Defect | Medium | Low | E 8–20 · T 10–20 | Low | C | W4 | Medium |
| [D4](#d4) | `created` is UTC and the id takes the UTC day | Closed | Defect | Medium | Low | E 8–15 · T 10–15 | Low | C | W4 | High |
| [D5](#d5) | One value for a list field is stored as a single value | Closed | Defect | Medium | Low | A 8–15 · T 10–15 | Low | C | W2 | High |
| [D6](#d6) | The same input produces a different file | Closed | Defect | Low | Low | E 15–30 · T 15–20 | Low | C | W4 | Medium |
| [D7](#d7) | A rewrite restyles the frontmatter and drops comments | Closed | Defect | Medium | Normal | E 30–60 · T 20–30 | Normal | C · Q | — | Medium |
| [D8](#d8) | Reverse fields are not maintained, and the released `check` then fails | Incompatible | Scope boundary | High | High | E 60–120 · T 50–80 | High | C · F | W6 | Low |
| [D9](#d9) | `rm` protects nothing | Closed | Defect | High | Normal | E 30–60 · T 25–40 | Normal | S | W6 | Medium |
| [D10](#d10) | System collections are not records | Missing | Scope boundary | Medium | Normal | E 40–80 · T 20–40 | Normal | C · F | W13 | Medium |
| [D11](#d11) | Binary records are refused; owner-folder storage is ignored | Missing | Scope boundary | Medium | High | E 100–200 · T 60–100 | Normal | C | — | Low |
| [D12](#d12) | `list` ignores flags it does not know; `get` prints another format | Partly closed | Defect | High | Normal | A 5–10 to refuse the flag; A 30–60 · T 25–45 to filter and sort | Low | S · F | W2 | Medium |
| [D13](#d13) | Twenty-six released verbs have no counterpart | Missing | Scope boundary | High | High | A 600–1,400 for all of them; per verb below | High | F · C | W6 · W9 · W13 | Low |
| [D14](#d14) | Clearing a field that has a default leaves it absent | Closed | Defect | Low | Low | E 3–8 · T 5–10 | Low | C | — | High |
| [V1](#v1) | `check` passes over files it does not recognise | Closed | Defect | High | Low | E 10–20 · T 10–15 | Low | S · C | W5 | High |
| [V2](#v2) | Dates and times are barely checked | Closed | Defect | High | Low | E 10–20 · T 15–25 | Low | S · C | W7 | High |
| [V3](#v3) | Rules in a descriptor that are not enforced | Partly closed | Scope boundary | High | High | E 60–110 · T 50–80; constraints E 60–150 more | High | S · C | W7 | Medium |
| [V4](#v4) | Stricter than the released engine in three places | Closed | Defect | Medium | Low | E 10–20 · T 10–20 | Low | C | W7 | Medium |
| [V5](#v5) | None of the checks that extensions and the released engine add | Missing | Scope boundary | Medium | Normal | E 30–60 for the engine's own; the rest is M5 | Normal | C | W6 · W13 | Low |
| [C1](#c1) | Ordinary text is refused or crashes, because values are parsed as YAML | Closed | Defect | High | Normal | A 40–70 · T 40–60 | Normal | F · Q | W2 | Medium |
| [C2](#c2) | Some text is silently changed or erased, for the same reason | Closed | Defect | High | Low | A 10–20 · T 15–25 | Low | S | W2 | High |
| [C3](#c3) | Flags are not read the way the released engine reads them | Closed | Defect | Medium | Low | A 15–30 · T 15–25 | Low | C | W2 | High |
| [C4](#c4) | `set` with nothing to set reports success | Closed | Defect | Medium | Low | A 5–10 · T 5–10 | Low | Q | W2 | High |
| [C5](#c5) | Short forms from the released documentation do not work | Closed | Scope boundary | Medium | Normal | A 25–50 · T 20–35 | Normal | C | W2 · W3 | Medium |
| [C6](#c6) | Mistakes and damaged files end in stack traces | Closed | Defect | Medium | Low | A 10–25 · T 15–25 | Low | Q | W2 | High |
| [C7](#c7) | The engine calls itself `dt`, has no `help`, and explains less | Closed | Defect | Low | Low | A 15–30 · T 5–10 | Low | Q | W2 | High |
| [A1](#a1) | Nothing delivers the instructions to an agent harness | Missing | Scope boundary | High | High | A 120–250 · T 60–120 | High | F | W8 | Low |
| [A2](#a2) | The instruction file does not carry enough to write a record | Closed | Scope boundary | High | Low | A 30–60 · T 15–25 | Low | F | W8 | High |
| [A3](#a3) | Skills have no path, and the pointers lead to the other engine | Closed | Defect | Medium | Low | A 10–20 · T 5–10 | Low | F · Q | W8 | High |
| [A4](#a4) | `model.json` holds absolute paths | Closed | Defect | Low | Low | A 5–10 · T 5–10 | Low | Q | W8 | High |
| [A5](#a5) | Nothing reports stale instructions | Missing | Scope boundary | Low | Normal | A 25–50 · T 15–25 | Normal | Q | W8 | Medium |
| [G1](#g1) | No `commit`, `changes`, `history`, `diff` or `revert` | Missing | Scope boundary | Medium | Normal | A 100–200 · T 50–90 | Normal | F | W9 | Medium |
| [F1](#f1) | `get` and `rm` follow a reference out of the workspace | Closed | Defect | High | Low | E 10–20 · T 20–30 | Low | S | W1 | High |
| [F2](#f2) | An empty or `..` id can delete a collection's folder, or all of `data/` | Closed | Defect | High | Low | E 5–10 · T 10–15 | Low | S | W1 | High |
| [F3](#f3) | An explicit id is not validated | Closed | Defect | High | Low | E 5–10 · T 10–15 | Low | S | W1 | High |
| [F4](#f4) | A descriptor decides where records are read and deleted | Partly closed | Scope boundary | Medium | Low | E 5–10 · T 5–10 | Low | S | W1 | Medium |
| [F5](#f5) | Two writers on one record: most conflicts are refused, a few updates are lost | Partial | Defect | Medium | High | E 20–50 · T 30–60 | High | S | W14 | Low |
| [F6](#f6) | The stale-write check has two open windows and no test | Partial | Defect | Medium | Normal | T 15–25; the fix is F5 | High | S | W14 | Low |
| [F7](#f7) | A crash leaves temporary files that nothing removes | Closed | Defect | Low | Low | E 8–20 · T 10–20 | Low | Q | W14 | Medium |
| [L1](#l1) | Engine floors and peer versions are ignored | Missing | Scope boundary | Medium | Normal | E 30–50 · T 20–30 | Normal | C · S | W11 | Medium |
| [L2](#l2) | No upgrade path, and orphaned records go unreported | Missing | Scope boundary | High | High | E 15–25 for a warning; A 150–400 for updates | High | F | W11 | Low |
| [U1](#u1) | No UI, and nothing to draw one from | Missing | Scope boundary | High | High | A 300–800 · T 100–200 | High | F | W13 | Low |
| [U2](#u2) | No live refresh | Missing | Scope boundary | Low | Normal | A 40–80 · T 20–40 | Normal | F | W13 | Low |
| [T1](#t1) | The CLI has no automated test; a third of the branches never run | Closed | Scope boundary | Medium | Normal | T 90–150 | Low | Q | W2 | High |
| [T2](#t2) | Nothing in the suite touches a real module | Closed | Scope boundary | Medium | Normal | T 60–120 | Normal | C | W12 | Medium |
| [T3](#t3) | The API is a fraction of the released one | Missing | Scope boundary | Medium | — | none of its own: it grows with what is built | — | F | — | — |

### How the estimates were made

The first five columns of the table are findings; the entry each row links to holds the evidence. The other six are estimates, made by reading the code. Nothing in them has been built.

| Column | Scale |
|---|---|
| **Effort** | Low: up to about half a day for someone who knows this code; a local change with no decision to make. Normal: one to three days; a new function, or a change across two parts. High: a week or more; a new subsystem, a design decision that is still open, or work that depends on code outside this engine |
| **Size, lines** | A range of lines added or changed, by kind. **E** is engine code (`src/discover.ts`, `src/model.ts`, `src/store.ts`). **A** is adapter code (`src/cli.ts`, `src/compile.ts`, or a new adapter such as harness output or a server). **T** is tests. **C** is configuration or packaging. No gap needs a change to a published module |
| **Complexity** | Low: one function, and the right behaviour is not in doubt. Normal: several functions or parts, behaviour known. High: correctness is hard to show (concurrency, writes to several files, an external tool), or the design is undecided |
| **Gain** | What closing it buys. **S** safety: no lost or exposed data, no false "all clear". **C** compatibility: the same files, ids and verdicts as the released engine and its modules. **F** function: something a user cannot do today. **Q** quality: clearer errors, less noise, safer to change |
| **Shared** | The work package the gap belongs to, from [Shared work](#shared-work). Gaps in one package share code and tests, so their sizes must not be added up; use the package's size |
| **Confidence** | In the size and effort. High: the change is local and the behaviour is pinned down by evidence in this report. Medium: the behaviour is known, and either a design choice or the released engine's exact algorithm still has to be settled. Low: it needs a decision, or depends on code outside this engine; the range could be wrong by a factor of two or more |

What the estimates rest on:

- **This engine's own density** (measured). 490 lines do discovery (46), the model (100), the store (174), compile (30) and the CLI (56). All validation is 36 lines. The five tests are 71 lines, about 14 a test.
- **The size of the comparable code in the released engine** (measured, as lines per file in dreamteamer 0.49.1). It is an upper bound, because that code serves a larger surface and carries long comments: the plural rules are 10 lines of `namespace.js`; `ref.js` 39; `relations.js` 62; `filter.js` 154; `template.js` 201 and `temporal.js` 157 for ids and dates; `check.js` 427; `harnesses.js` 649; `commit.js` 611 and `history.js` 90; `placement.js` 219; `install-modules.js` 450, `init.js` 473 and `update.js` 139; `semver.js` 36; `schema-ops.js` 2,959 for the schema verbs.
- **What published extensions ask of an engine** (measured). Their entry points are 10 to 47 lines, and behind them are about 6,200 lines of module code that call about a dozen names on the engine's API, `Store` most often.

Assumptions:

- New code is written in the style of the existing code, with no new runtime dependency unless the row says so.
- A behaviour gets one test of 15 to 25 lines. The CLI has no test harness yet; the first package that needs one (W2) pays for it.
- The low end of a range covers the behaviour the published modules need today. The high end adds the messages and edge cases the review found.
- An estimate is for doing that gap alone. Where gaps share a package, doing them together costs the package's size, which is less than the sum of the rows.
- Effort is for a person. The first 490 lines were written by an agent in minutes, so calendar time depends on who does the work; treat size as the firmer number and effort as its reading on the scale above.

`D13` covers many verbs. Taken one at a time: `resolve` A 20–35; `values` A 10–15; `rename` E 50–90, and it needs the reference scan of W6; `reorder` E 30–50; `exports` A 60–100; `next` A 80–150, and it needs the command bindings of M4; the six schema verbs A 300–700 together. `commit`, `changes`, `history`, `diff` and `revert` are W9, `relations` is W6, and `init`, `install`, `update`, `setup`, `doctor` and `status` are W11.

### Shared work

Sizes here are for closing all the gaps of a package together.

| Package | Closes | Size together | Effort | What is shared, and what the estimate rests on |
|---|---|---|---|---|
| **W1** Reference guard | F1 F2 F3, and F4 as a warning | E 15–30 · T 30–50 | Low | One function that refuses an empty id, a `.` or `..` segment and a leading slash, and checks the resolved path, called from `get`, `add`, `set` and `rm`. The released engine's `ref.js` is 39 lines |
| **W2** Typed command line | C1 C2 C3 C4 C5 C6 C7 D5 S3 T1, and D12's refusal of unknown flags | A 90–160 · T 90–150 | Normal | A rewrite of the 53 lines of `src/cli.ts`: a value is converted by the declared type of its field, not parsed as YAML; flag forms; a title as a bare argument; every error caught. The model already holds each field's type. The tests include the CLI harness that T1 lacks |
| **W3** Names | D1, and the singular forms of C5 | E 20–35 · T 15–25 | Low | The released engine's ten plural rules, and a descriptor's own `singular`, used for the file suffix and for the name on the command line |
| **W4** Ids and timestamps | D2 D3 D4 D6 | E 45–90 · T 40–70 | Normal | Filters with an argument, `basename`, a local `created` with its offset, slugs for accented names, and the released engine's hash for names with no Latin letters. Today's id code is 11 lines. The released algorithms must be matched exactly or ids diverge |
| **W5** Honest loading | M2 M3 M6 R2 V1 | E 50–90 · T 40–60 | Normal | Model errors stop a write and fail `compile`; `peer_collections` is honoured, so a declared peer keeps its field; an unknown type is an error, not a dropped field; unrecognised files are reported |
| **W6** Relations | D8 D9, the stale-mirror part of V5, `rename` and `relations` from D13 | E 100–190 · T 70–110 | High | A scan that answers "which records point at this one". `rm` uses it to refuse (D9, the cheaper half, E 30–60). Maintaining reverse fields (D8) adds writes to more than one file per command |
| **W7** Validation depth | V2 V3 V4 R4 | E 80–150 · T 70–110, and E 60–150 more for cross-field constraints | Normal; High with constraints | Real date and time checks, formats, bounds, nested objects, map values, uniqueness, soft references, and the same leniency as the released engine. Constraints are JSON Schema `if`/`then` rules: a small evaluator, or a schema library as a second runtime dependency |
| **W8** Agent delivery | A1 A2 A3 A4 A5, and the commands, agents and skills of M4 | A 150–300 · T 60–120 | High | Richer instruction content, relative paths and a staleness stamp are small (A2 to A5, A 70–140). Writing into each harness's own files is the large part, and needs a decision on who owns those files |
| **W9** Git verbs | G1, and `commit`, `changes`, `history`, `diff`, `revert` from D13 | A 100–200 · T 50–90 | Normal | The first code here that runs another program. Tests need throw-away repositories |
| **W10** Workspace arrangements and the module contract | M7 M8 M9 R3 | E 180–330 · T 130–210 | High | Record layers are the largest part (E 60–120). The rest is many small rules, each needing a fixture |
| **W11** Install and lifecycle | S2 M1 L1 L2 | A 300–650 · T 150–300 | High | Driving npm, pinning, presets, version floors, updates. All of it is Open in the design. M1 has a cheap variant: follow `dreamteamer.dependencies` into `node_modules` at discovery (E 15–30), which departs from the released engine's rule |
| **W12** Distribution | S1 S4 S5 T2 | C 40–90 · T 60–120 | Normal | A build step or published JavaScript, a bin name of its own, a CI matrix, a licence, and a test suite that installs real published modules |
| **W13** Extensions and UI | M5 U1 U2 D10 R1, the extension part of V5, the views, navigation and bindings of M4, `next` from D13 | A 600–1,600 · T 200–400 | High | To run published extensions unchanged the engine must offer the API they call. A UI needs display metadata, views, navigation and a host for the existing UI package. The least certain figures in this report |
| **W14** Concurrency and crash residue | F5 F6 F7 | E 30–70 · T 50–100 | High | Removing leftover temporary files is small (F7). Closing the lost-update windows is not: the released engine has a lock and loses more |

`D7`, `D11` and `D14` share nothing. `T3` is not work of its own.

## Recommendations

This section is a proposal. It reads across the table and suggests what to build; the sizes in it are the estimates above, combined so that shared work is counted once.

**Outcome.** The sweet spot below was built in `143c57a`. It closed 34 gaps and part of 4, against the 36 and 2 proposed: [D12](#d12) and [R4](#r4) were closed in part, not in full. The code came to 544 lines added and 190 removed, inside the estimated 400 to 800; the tests to 391 added, a little under the estimated 450 to 750. Two pieces were done differently from the proposal. Rewrites preserve a file by editing only the lines of the keys that change, not through the YAML library's document model, which turned out to restyle comments, folded strings and inline lists. And the suite on real modules needed the released engine's own package as a development dependency, because `@dreamteamer/rnd` refers to a collection that package defines. The rest of this section is as it was written before the work; its "would" is now "does", except where it describes what was left out.

### The sweet spot: a safe record engine that published modules can rely on

**Close 36 of the 64 gaps, in thirteen pieces of work, none of them High.**

| Piece | Gaps | Why it is in |
|---|---|---|
| W1 Reference guard | F1 F2 F3 F4 | The two worst defects in the report are here, and the fix is one small function |
| W2 Typed command line | C1 C2 C3 C4 C5 C6 C7 D5 S3 T1 | Ends the silent erasure of a field (C2) and the refusal of ordinary titles (C1), and gives the CLI its first tests. The largest piece |
| W3 Names | D1 | Without it this engine cannot see the records of two published collections |
| W4 Ids and timestamps | D2 D3 D4 D6 | Without it `add` fails in twelve published collections and ids differ from the released engine's |
| W5 Honest loading | M2 M3 M6 R2 V1 | A broken model, a typo in a descriptor and an absent peer stop being silent |
| The `rm` half of W6 | D9 | A delete stops breaking the records that point at it, and a folder record is no longer emptied without asking |
| The cheap half of W7 | V2 V4 R4, and formats and bounds from V3 | Impossible dates are refused, and the two engines agree on more of what is valid |
| Instruction content from W8 | A2 A3 A4 | The file an agent reads says enough to write a record, and names a command that exists |
| A filter for `list` | D12 | Answers "what is assigned to this person" without reverse fields, and ends the unfiltered answer to a filtered question |
| Rewrites that preserve the file | D7 D14 | A one-field change becomes a one-line diff, and comments survive |
| Temporary files removed | F7 | Small, and it keeps `data/` clean after a crash |
| A suite on real modules | T2 | Everything above is a compatibility claim; this is what keeps it true |
| A licence | S5 | No code |

**What it costs.** About 400 to 800 lines of engine and adapter code and 450 to 750 lines of tests. Some 50 of today's lines are replaced, so the engine would be roughly 850 to 1,250 lines — still about a twentieth of the released engine — and the test suite would grow from 71 lines to between 500 and 800. On the effort scale that is five Low pieces and eight Normal ones: two to five working weeks for one person, less where an agent writes the tests. The total is more certain than its parts, because most of these pieces are rated High or Medium confidence.

**What users could then do.**

- Point this engine at an existing workspace of published modules and read, add, change and delete records, with the same file names, ids and timestamps as the released engine writes.
- Type ordinary text on the command line, and get a one-line message for a mistake.
- Trust that a reference or an id cannot reach outside the record it names, and that `rm` will not break or take other records with it.
- Trust `check` further: it reports files it does not recognise, refuses impossible dates, and treats an absent optional peer as the released engine does.
- Filter a list.
- Hand an agent an instruction file it can work from.

**What would still be unavailable.**

- Reverse fields. A write that sets a reference would still leave the other side unmaintained, so the released engine's `check` would still report it stale. The filter on `list` gives the same answer by asking the forward question. This is the first thing to add next.
- Delivery to an agent harness. A person would still point the agent at the file.
- `commit` and the other git verbs, `install`, `rename`, `next`, the schema verbs.
- Commands, bindings, views, navigation, extensions and a UI.
- Cross-field constraints, uniqueness, binary records, record layers.

**Dependencies, in the order they bite.**

1. W1 comes first and stands alone.
2. W2 builds the CLI test harness that later pieces reuse. Its singular forms need W3.
3. W5's handling of peers should land before anyone trusts `check` on a workspace with modules missing.
4. D9 builds the reference scan, which is also the first half of reverse fields.
5. T2 should grow with W3, W4 and W5, not after them.

**Risks and the least certain estimates.**

- **W2 is the largest piece and a design, not a patch.** Converting a value by its field's type raises questions the current code never faced: how an `object` or a `map` is written on the command line, and what a bare argument means for a collection whose title field is not `name`.
- **W4 must match the released engine exactly.** Its hash for names with no Latin letters and its date formatting have to produce the same characters, or the two engines keep giving one record two ids. That code has not been read in full; it is 358 lines there.
- **W5 changes what `check` reports for an absent peer.** The right rule is the released engine's, and "a reference that cannot be resolved, and is not wrong" needs a place in a validator that today knows only valid and invalid.
- **D7 depends on the YAML library keeping a document's style when one value changes.** It offers that; whether it leaves long folded strings alone has not been tried.
- **T2 makes the test suite depend on published packages**, and so on a registry or on stored copies.

**What is left out because it costs too much for what it buys now.**

| Left out | Estimated cost | Consequence |
|---|---|---|
| Extensions (M5) | A 150–400, Low confidence | Five published modules stay reduced to their collections: no file sync, no session verbs, no web pane, no lifecycle checks |
| A UI and what it needs (U1 U2 R1 D10) | A 400–1,000 | No way to look at a workspace through this engine. Because the files would match, the released engine and its UI could still display a workspace this one writes |
| Install, update and migrations (W11) | A 300–650 | Modules are installed and upgraded by hand with npm, as the README describes |
| The schema verbs (D13) | A 300–700 | A field is added by editing YAML. That is less of a loss here than in the released engine, since no compile step follows |
| Record layers and other arrangements (M8) | E 100–200 | A workspace that reads another workspace's records is limited to the exports manifest |
| Hardening against concurrent writers (F5 F6) | E 20–50, High complexity | A few updates in a hundred are still lost under contention. That is already better than the released engine |

### Two other options, for comparison

| | Minimal safe | Sweet spot | Broader compatibility |
|---|---|---|---|
| **Aim** | Nothing in this engine can lose or expose data, or report a false "all clear" | A safe record engine that published modules can rely on | An engine that could stand in for the released one in an agent's daily loop |
| **Includes** | W1; from W2 only what stops C2, catches errors and refuses unknown flags; the folder-record guard of D9; M2; V1 | As above | The sweet spot, then D8, A1 and A5, G1, W10, the rest of V3 with constraints, L1, binary records, `rename`, `resolve` and `values`, M1's cheap variant, S1 |
| **Gaps closed** | 7 of 64, and 4 more in part | 36 of 64, and 2 more in part | About 47 of 64, and 5 more in part |
| **Code added** | 75–150 lines | 400–800 lines | 1,100–2,200 lines |
| **Tests added** | 100–175 lines | 450–750 lines | 900–1,500 lines |
| **Engine afterwards** | About 600 lines | About 850–1,250 lines | About 1,550–2,650 lines |
| **Hardest piece** | None is hard | W2, a redesign of the CLI | D8 and W10: writes to several files, and many small rules |
| **A user can** | Try it on a copy without fear | Do record work on a real workspace of published modules | Also share a workspace with the released engine, commit by record, and have instructions delivered to a harness |
| **A user still cannot** | Use it on a real workspace: file names and ids still differ, ordinary titles are still refused | Have reverse fields maintained, deliver to a harness, commit through the engine | Run extensions, see a UI, install or upgrade through the engine, use the schema verbs |

**Where the returns diminish.** Up to the sweet spot every piece is cheap for what it closes: ten to twenty lines of code per gap. Just past it sit three items that users would feel every day, at about 160 to 320 lines together: reverse fields (D8), delivery to one harness (the smallest cut of A1, A 40–80), and `commit` with `changes` (the first half of G1). They are worth taking next, in that order, and D8 first needs a decision: storing reverse fields as the released engine does means a command writes several files, which gives up the "one write, one file, one rename" that makes this engine's writes simple to reason about; deriving them when a record is read keeps that and stops matching the released engine's files.

Beyond those three the cost per gap rises steeply and the audience narrows. W10 is 180 to 330 lines for arrangements that no published module uses today. Constraints are 60 to 150 lines for five collections. Extensions, a UI, install with updates, and the schema verbs are about 1,200 to 2,800 lines between them, at Low confidence — the point at which this stops being an engine small enough to read, which was the reason for the experiment.

## Getting started and packaging

<a id="s1"></a>
### S1 · Cannot be installed as a package, and takes over `dt` if it is
*Missing · Scope boundary · impact medium*

**README:** "The package cannot be installed from npm or from a tarball yet" (Planned).

**Actually:** `package.json` declares a `bin` named `dt` and a `main`. Neither works once the package sits in `node_modules`, and installing it replaces the released engine's `dt`.

```
$ ls -l node_modules/.bin/dt                            # the side-by-side workspace
node_modules/.bin/dt -> ../dreamteamer/bin/dreamteamer.js
$ npm pack <checkout> && npm install ./dreamteamer-first-principles-0.0.0.tgz
$ ls -l node_modules/.bin/dt
node_modules/.bin/dt -> ../dreamteamer-first-principles/bin/dt.ts
$ npx dt list tasks
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules …
```

`npm install <checkout folder>` links the folder instead, and that does run. As a side effect npm sets the executable bit on `bin/dt.ts` in the checkout, where it is committed without one. The committed `package-lock.json` is also behind `package.json`, so `npm install` in a fresh clone modifies it.

**Impact:** A workspace cannot depend on this engine or pin it, and trying to breaks `npx dt` for the released one. It needs a build step, or JavaScript published in place of TypeScript, and a bin name of its own.

<a id="s2"></a>
### S2 · No `init`, `install`, `update`, `status`, `doctor` or `setup`
*Missing · Scope boundary · impact medium*

**README:** A workspace is made by hand with `git init`, `npm init` and `npm install` (Open).

**Actually:** As described. For comparison, the released engine's two commands:

```
$ npx dreamteamer@0.49.1 init
✔ 0 violations (16 records across 10 collections)
✔ git: committed package.json, package-lock.json, .gitignore, .env.example, .vscode/extensions.json, modules/default/…
$ npx dreamteamer install @dreamteamer/tasks
✔ installed @dreamteamer/users, @dreamteamer/tasks — compiled, committed (package.json, package-lock.json, .env.example)
```

**Impact:** A new user types five commands where the released engine needs two, must know to pin versions and to list dependencies ([M1](#m1)), and has no command that says what works on this machine.

<a id="s3"></a>
### S3 · A folder that is not a workspace is accepted, or crashes
*Partial · Defect · impact medium*

**Closed in `143c57a`.** A folder with no `package.json`, or with no DreamTeamer module, is refused by every verb in one line, and nothing is written there.

**README:** "A workspace is a folder with a `package.json`"; "Run outside a workspace, every verb does" end in a stack trace.

**Actually:** Any folder with a `package.json` is taken for a workspace, so a wrong `-w` reports a clean check and `compile` writes into it. A folder without one crashes every verb, the usage line included, because the model is built before the verb is read (`src/cli.ts:25`).

```
$ mkdir other && echo '{"name":"some-lib","version":"1.0.0"}' > other/package.json
$ dtx check -w other
0 records · 0 collections · 0 modules · 0 errors · 0 warnings          # exit 0
$ dtx compile -w other && ls -a other
. .. .dt package.json
$ mkdir empty && cd empty && dtx
Error: ENOENT: no such file or directory, open '…/empty/package.json'
$ rel check -w other                                    # the released engine
✖ --workspace …/other — …/other is not a workspace (no package.json with a "dreamteamer" section)
```

**Impact:** A script or an agent that passes the wrong path is told the workspace is valid when nothing was checked, and leaves a `.dt/` folder in an unrelated repository.

<a id="s4"></a>
### S4 · The Node floor is declared, not measured
*Unverified · Unverified claim · impact low*

**README:** "23.6 or later … It has been run on Node 25.4 and 22.23, on macOS only."

**Actually:** `package.json` declares `engines.node >=23.6`. The engine runs unflagged on the two versions on this machine, one of them below that floor:

```
$ ~/.nvm/versions/node/v22.23.2/bin/node <checkout>/bin/dt.ts check
2 records · 4 collections · 3 modules · 0 errors · 9 warnings
```

Nothing has been run on Linux or Windows, on Node 20 (which the released engine supports), or on any 23.x.

**Impact:** The declared floor is neither the lowest version that works nor a tested one.

<a id="s5"></a>
### S5 · No licence
*Missing · Scope boundary · impact low*

**Closed in `143c57a`.** `LICENSE` is the repository's Apache-2.0, and `package.json` says so.

**README:** "Not settled for this branch."

**Actually:** There is no `LICENSE` file, and `package.json` says `"license": "ISC"` because `npm init` wrote it. The released engine is Apache-2.0.

**Impact:** None while the branch is local and the package private. It must be settled before the branch is published.

## Modules and discovery

<a id="m1"></a>
### M1 · Nothing installs a module's dependencies or a preset's members
*Missing · Scope boundary · impact high*

**README:** "Name every module you want, including the ones another module depends on … The same goes for the members of a preset package such as `@dreamteamer/core`: nothing installs them for you."

**Actually:** The discovery rule itself matches the released engine: both read only the packages named in the workspace's own `package.json`, and on the real workspace both find the same 22 modules and skip the same 2 that are present only as dependencies. What is missing is the verb that puts them there.

```
$ mkdir ws && cd ws && npm init -y && npm install --save-exact @dreamteamer/tasks@0.3.4
$ ls node_modules/@dreamteamer
tasks
users
$ dtx check
✖ @dreamteamer/tasks: depends on module @dreamteamer/users, which is not installed
⚠ tasks.assignee: points at users, not installed — field dropped
…
0 records · 1 collections · 1 modules · 1 errors · 6 warnings
$ dtx add tasks --name "Second" --assignee users/dana-oren
✖ tasks/2026-11-17--second rejected — nothing written
  tasks/2026-11-17--second: assignee: unknown field
```

A preset fares the same. `@dreamteamer/core` 0.13.1 pins 17 members under `dreamteamer.preset` and has no npm dependencies, so `npm install @dreamteamer/core` in the walkthrough workspace leaves `node_modules/@dreamteamer` holding `core tasks users` and nothing else. The released `install` adds every dependency and every preset member as an exact direct dependency (S2 shows it adding `users`).

**Impact:** The obvious first command gives a workspace in which `assignee` is an unknown field, with a message that says the module is not installed when npm has installed it. The released README's one-line start, `install @dreamteamer/core`, yields an empty workspace here.

<a id="m2"></a>
### M2 · A broken model stops nothing
*Partial · Defect · impact high*

**Closed in `143c57a`.** An error in the model stops `add`, `set` and `compile`, and each prints it.

**README:** "`check` prints those issues; the other verbs do not."

**Actually:** In the workspace of M1, where `check` exits 1, `compile` and `add` both succeed without a word:

```
$ dtx check   >/dev/null; echo $?        # 1
$ dtx compile >/dev/null; echo $?        # 0
$ dtx add task --name "Buy milk" >/dev/null; echo $?        # 0
$ grep -c '"severity": "error"' .dt/model.json              # 1
```

`model.issues` is read in one place, `src/store.ts:163`. The released `compile` fails on the same condition (in the review: "depends on …, which is not installed", exit 1).

**Impact:** Records are written, and instructions are generated, from a model the engine already knows is incomplete. A pipeline that gates on `compile` proceeds.

<a id="m3"></a>
### M3 · Manifest keys and workspace settings are ignored without a word
*Partial · Defect · impact medium*

**Closed in `143c57a`.** `modules` now reports `preset`, `env` and `engine`, and `check` warns about a `data_path` or `git_modules` setting it does not honour. `workspace_module` and `harnesses` are still passed over in silence.

**README:** "It sees, and reports through `dtx modules`, the manifest keys `extension`, `nav`, `setup`, `peer_collections`, `ignore` and `vars` … It does not notice `preset`, `env` or `engine`."

**Actually:** The list of keys it reports spells `preset` as `presets` (`src/discover.ts:6`), and has no entry for `env` or `engine`.

```
$ npm install --save-exact @dreamteamer/core@0.13.1 && dtx modules | grep core
@dreamteamer/core@0.13.1 [npm] — not implemented here: nav
$ node -p "Object.keys(require('@dreamteamer/core/package.json').dreamteamer).join()"
title,description,engine,preset,nav
```

Of the workspace's own `dreamteamer` settings only `disable` is read ([M7](#m7)). `workspace_module`, `data_path`, `harnesses` and `git_modules` do not appear in `src/` at all. An unknown key is accepted in both places; the released engine refuses one at compile ([M9](#m9)).

**Impact:** The "not implemented here" line understates what is being skipped. A reader who trusts it does not learn that a package is a preset, that a module declares an engine floor ([L1](#l1)), or that it needs environment values.

<a id="m4"></a>
### M4 · Commands, agents, bindings, views, navigation and scripts are not read
*Missing · Scope boundary · impact high*

**README:** "It does not read commands, agents, command bindings, UI views or navigation documents".

**Actually:** As described. Counted over the 21 published packages of the real workspace:

| Source kind | Files | Read here |
|---|---|---|
| Collection descriptors (13 of them overlays) | 67 | yes |
| Mixins | 2 | yes |
| Skills | 21 | name and description only |
| Commands | 30 | no |
| Command bindings | 43 | no |
| UI views | 27 | no |
| Scripts a module ships under `bin/` | 19 | no |
| Agents | 3 | no |
| Navigation documents | 2 | no |

**Impact:** Everything a module ships beyond its nouns is absent: the slash commands that start a procedure, the bindings that say which command applies to a record in which state (32 of the 43 are the R&D lifecycle), the views a UI draws, and the sidebar. Apart from `nav`, nothing reports that these were skipped.

<a id="m5"></a>
### M5 · Extensions contribute nothing
*Missing · Scope boundary · impact high*

**README:** "it runs nothing an extension contributes" (Open).

**Actually:** Five of the 21 packages declare `dreamteamer.extension`: `@dreamteamer/files`, `recordings`, `rnd`, `sessions` and `web`. This version prints `not implemented here: extension` for each and loads none.

```
$ dtx files sync
dt modules | collections | list <collection> | get <ref> | …          # the usage line, exit 2
```

In the review, calling each extension's entry point showed what is lost: verbs (`files`, `session`, `web`, `serve`), setup units (`files`, `recordings`), a source kind (`session-bindings`), and check rules ([V5](#v5)).

**Impact:** File indexing, session records, the web pane and the R&D lifecycle checks are all behaviour of extensions. Whether this version loads module code at all is an open design question, and until it is settled these five modules are reduced to their collections.

<a id="m6"></a>
### M6 · An absent optional peer makes records uneditable
*Incompatible · Defect · impact high*

**Closed in `143c57a`.** `peer_collections` is honoured: a declared peer that is not installed keeps its field, a value there is counted by `check` as unresolved, and the record stays editable.

**README:** "A record that already holds a value in such a field then fails `check` and cannot be edited until the field is removed or the peer installed".

**Actually:** A field whose type names a collection that is not installed is removed from the model (`src/model.ts:71`). A record that holds a value there is then invalid, and every `set` on it is refused. The released engine keeps the field when the module declares the peer in `peer_collections`.

```
$ mkdir -p data/tasks
$ printf -- '---\nname: Ship the website\nproject: projects/website\n---\n' > data/tasks/2026-11-17--ship-the-website.task.md
$ dtx check
✖ tasks/2026-11-17--ship-the-website: project: unknown field
$ dtx set tasks/2026-11-17--ship-the-website status=doing
✖ tasks/2026-11-17--ship-the-website rejected — nothing written
$ rel check                                             # the same file, the released engine
⚠ peer collection "projects" is declared but not installed — 1 reference unresolvable
✔ 0 violations (32 records across 13 collections)
$ rel set tasks/2026-11-17--ship-the-website status=doing
✔ R · updated
```

The nine warnings a healthy walkthrough workspace prints are the same mechanism: all nine collections are declared peers of `@dreamteamer/tasks` or `@dreamteamer/users`.

**Impact:** Nine published modules declare optional peers. Uninstalling one, or opening a workspace before all are installed, turns valid records red and locks them. A healthy workspace also always shows warnings, so a real one does not stand out.

<a id="m7"></a>
### M7 · `disable` means something else here
*Incompatible · Defect · impact medium*

**README:** "This is not the released engine's list, which names `modules/<id>` or `<kind>/<id>`".

**Actually:** This version skips a dependency whose package name is listed (`src/discover.ts:31`). The released engine reads the same list as `modules/<id>` or `<kind>/<id>`. Each engine ignores the other's spelling.

```
"disable": ["modules/@dreamteamer/tasks"]
$ rel compile      ✔ compiled 12 collections … from 3 module(s)         # tasks dropped
$ dtx collections | grep -c '^tasks'     1                               # still there

"disable": ["@dreamteamer/tasks"]
$ rel compile      ⚠ dreamteamer.disable entry "@dreamteamer/tasks" matched nothing
$ dtx collections | grep -c '^tasks'     0                               # dropped
```

**Impact:** A workspace's existing `disable` list does nothing here, and nothing says so. The forms that drop a single skill or collection have no equivalent.

<a id="m8"></a>
### M8 · No record layers, git-delivered modules, classic layout or `data_path`
*Missing · Scope boundary · impact medium*

**README:** "The released engine's other arrangements are not read".

**Actually:** None of `git_modules`, `data_path` or `workspace_module` appears in `src/`. In the review, on synthetic workspaces:

| Arrangement | Released engine | Here |
|---|---|---|
| A record layer: another workspace's records read through `git_modules` | reads them; `check` passes with a notice | `no such record`; references to them are broken |
| A module delivered as a git clone under `git_modules/` | compiled | not found |
| Classic layout: the workspace's own sources at its root | compiled as the workspace's module | not read as sources; a root `collections/` file is listed as a record of the system collection `collections` |
| `data_path: records` | records under `records/` | records under `data/`, so the two engines write to different folders |
| A local copy of an installed module under `modules/` | the local copy wins, with a notice | both load; the collection is a duplicate and the npm copy wins |

`dreamteamer-exports.json` is read, so a reference to an id it vouches for is accepted.

**Impact:** A workspace that reads, or is read by, another workspace works only as far as the exports manifest goes. The documented way to work on an installed module locally produces an error and uses the installed copy.

<a id="m9"></a>
### M9 · The module contract is not enforced
*Missing · Scope boundary · impact medium*

**README:** "It does not enforce the rules the released engine applies when it compiles a module".

**Actually:** The released engine refuses a module that breaks its contract; this version loads it.

```
# a local collection named lab/samples, with no namespace declared
$ rel compile
✖ compile error: collection "lab/samples" is namespaced, but "lab" is not declared — add it to `dreamteamer.namespaces` …
$ dtx check
0 records · 14 collections · 4 modules · 0 errors · 9 warnings

# "colour": "red" under the module's dreamteamer key
$ rel compile
✖ compile error: modules/default/package.json: unknown dreamteamer key(s) colour — the keys are title · description · …
$ dtx check
0 records · 13 collections · 4 modules · 0 errors · 9 warnings
```

In the review the same held for a reference to a collection the module neither owns nor declares, an overlay from a module that does not depend on the collection's owner, an overlay of a collection that is neither installed nor a declared peer, an unknown folder in a module, and a preset that ships sources.

**Impact:** A module developed against this engine gets no feedback about its contract and can fail to compile on the released one.

## The resolved model

<a id="r1"></a>
### R1 · Display metadata and other descriptor keys are dropped
*Missing · Scope boundary · impact high*

**README:** "Display metadata, record titles, constraints and every other descriptor key are dropped."

**Actually:** As described. Of the 67 published collection descriptors, 55 carry a `display` block, 11 a `record_title`, 9 `internal`, 5 `constraints` and 3 an authored `singular`.

```
$ dtx compile && grep -c '"display"' .dt/model.json
0
$ grep -c '^display:' node_modules/@dreamteamer/tasks/collections/tasks.collection.yaml
1
```

**Impact:** `model.json` is described as the input for tools and UIs, and it lacks what a UI draws from: columns, sort order, navigation, record titles. An authored `singular` is not honoured, so `meeting-analysis` and `responsibility` are unknown collections ([C5](#c5)).

<a id="r2"></a>
### R2 · A typo in a descriptor is accepted, and can remove a field
*Partial · Defect · impact high*

**Closed in `143c57a`.** An unknown type, an unknown storage format and a field with no type are errors that stop writes; an unknown descriptor key is a warning; `position` is a known type.

**README:** "A misspelt type is taken for an absent collection, and the field is dropped with a warning."

**Actually:** An unknown key is accepted. An unknown type is treated as a reference to a collection that is not installed, so the field vanishes. The released type `position` gets the same treatment, and an unknown storage format is used as a file extension. In the review, a descriptor in the older format with no `fields` was accepted too, and every field of its records was then unknown.

```
$ cat > modules/home/collections/gadgets.collection.yaml <<'EOF'
name: gadgets
colour: red
storage: { path: data/gadgets, format: toml }
fields:
  name: { type: string, required: true }
  size: { type: strng }
  rank: { type: position }
EOF
$ dtx check
⚠ gadgets.size: points at strng, not installed — field dropped
⚠ gadgets.rank: points at position, not installed — field dropped
2 records · 5 collections · 3 modules · 0 errors · 11 warnings
$ dtx add gadgets --name "Pocket lamp"
✔ gadgets/pocket-lamp · …/data/gadgets/pocket-lamp.gadget.toml        # the content is YAML
$ rel compile                                           # the released engine, the size line alone
✖ compile error: collection "gadgets" (modules/default/collections/gadgets.collection.yaml): …
```

**Impact:** A module author's typo silently changes the schema. Records that hold the dropped field then fail as "unknown field", and the warning blames a missing module.

<a id="r3"></a>
### R3 · Composition differs at the edges
*Incompatible · Defect · impact medium*

**README:** "Where two modules shape the same collection, a few outcomes differ from the released engine".

**Actually:** Adding fields through an overlay, and refining a field key by key, resolve identically in both engines — that is the common case. All 13 published overlays are of that kind: they resolve to the same field definitions, in a different order. In the review, on synthetic modules, these cases differed:

| Case | Released engine | Here |
|---|---|---|
| Order of fields | The collection's own, then mixin and overlay fields, body last | Mixin fields first; overlay fields after the body (6 of 54 real collections) |
| A local and an npm overlay redefine one field | the npm overlay wins | the local overlay wins |
| An overlay sets `use_when`, or lists a mixin | applied | ignored: only its `fields` are read |
| A mixin supplies `storage` or `ids`, and the collection sets one key of the same block | merged key by key | the collection's block replaces the mixin's, so the id rule or suffix is lost |
| A mixin and the collection both declare a field | compile error | merged silently; the collection's wins |
| Two modules ship a mixin of the same name | compile error | the last one loaded wins silently |
| Two modules declare the same collection | compile error | an error in `check`; `compile` still succeeds with the first one |

**Impact:** Field order already differs in 6 of the 54 published collections. No published collection hits the other cases today. A workspace that customises one — a local overlay on a field another module also overlays, a mixin with one tweaked key — gets a different schema, or a different file name for the same record, on each engine.

<a id="r4"></a>
### R4 · The fields the engine adds itself differ
*Incompatible · Defect · impact medium*

**Partly closed in `143c57a`.** `updated` is refused unless a collection declares it, and `created` must be a date and time. `created` is still not derived for a record whose file has none.

**README:** "`created` and `updated` are always allowed" and neither is validated.

**Actually:** This version accepts `created` and `updated` on any record and checks neither (`src/store.ts:10`). The released engine treats `created` as a date-time it validates and derives on read, and does not know `updated` unless a collection declares it.

```
$ dtx add users --name "Ivan Petrov" --updated 2026-11-01            # accepted here
$ rel check
✖ data/users/ivan-petrov.user.md
    unknown field "updated" (not in the users schema)
$ printf -- '---\nname: Old Hand\ncreated: last week\n---\n' > data/users/old-hand.user.md
$ dtx check | tail -1
2 records · 13 collections · 4 modules · 0 errors · 9 warnings
$ rel check
✖ data/users/old-hand.user.md
    field created: "last week" must match format "date-time"
```

In the review, the released `get --json` also returned a `created` for records whose file has none — from the id's date or the commit time — which accounted for the only difference in 88 of 240 sampled records.

**Impact:** This version can write a record the released engine rejects, and accepts one it would reject. Sorting by `created` finds no value here for hand-written records.

## Records and data operations

<a id="d1"></a>
### D1 · Wrong file suffix for plurals that do not end in a plain "s"
*Incompatible · Defect · impact high*

**Closed in `143c57a`.** The file suffix and the singular follow the released engine's plural rules. On the real workspace all 131 user stories are seen and the 11 errors are gone.

**README:** "That rule is wrong for other plurals — `companies` becomes `companie` where the released engine writes `company`".

**Actually:** The suffix is the collection's name with one final `s` removed (`src/model.ts:31`). In the side-by-side workspace, after `rel install @dreamteamer/companies`:

```
$ rel add companies --name Northwind
✔ R · data/companies/northwind.company.md
$ dtx list companies | wc -l
0
$ dtx add companies --name Tailspin
✔ companies/tailspin · …/data/companies/tailspin.companie.md
$ rel check
⚠ data/companies/tailspin.companie.md — unrecognized file in companies folder
```

Two published collections are affected: `companies` and `rnd/user-stories`. On the real workspace `rnd/user-stories` holds 131 files ending in `.user-story.md`. This version lists none of them, and its `check` reports 11 broken references, every one a reference to one of those records. Correcting the suffixes in memory, in the review, brought it from 4,705 records and 11 errors to 4,836 records and none.

**Impact:** For these collections the engines cannot share a workspace. Each one's records are invisible to the other, every reference to them is reported broken, and an `add` creates a second file for an id that already exists.

<a id="d2"></a>
### D2 · Id rules that published modules use are not understood
*Partial · Defect · impact high*

**Closed in `143c57a`.** `date:FORMAT`, `basename` and `pad` are implemented, and an unknown filter is an error. Tests compare a meeting id and a release id with the released engine's.

**README:** "Published modules also use `basename` and formatted dates such as `date:YYYY/MM`, which are not understood."

**Actually:** A filter with an argument does not match the template pattern, so its braces stay in the id (`src/store.ts:127`). A filter the engine does not know is treated as doing nothing (`src/store.ts:129`), so a whole reference lands in the id.

```
$ npm install --save-exact @dreamteamer/meetings@0.4.0
$ dtx add meetings --name "Weekly sync" --starts 2026-12-01T10:00:00+02:00
✖ meetings/{{ starts | date:YYYY/MM }}/2026-12-01--{{ starts | date:HH-mm }}--weekly-sync rejected — nothing written
  …: id does not match ^\d{4}/\d{2}/\d{4}-\d{2}-\d{2}--[a-z0-9-]+$
```

Over the published descriptors there are 47 uses of `slug`, 22 of `date`, 11 of `basename`, 6 of `date:YYYY/MM` and 2 of `date:HH-mm`. Twelve collections use one of the last three: `meetings`, `meeting-recordings`, `meeting-summaries`, `meeting-analyses`, `files`, `deliverables`, `metrics`, `sessions`, `rnd/tests`, `rnd/releases`, `rnd/review-findings` and the system collection `command-bindings`. In the review most were refused by their id pattern, as above; `files` was not, because its pattern is loose, and the record was written under `files/file-drives/shared-drive/reports/q3.pdf` where the released engine writes `files/shared-drive/reports/q3.pdf`.

**Impact:** `add` cannot create a record in most of those collections without an explicit `--id` — which works, nested folders included. (`metrics` is affected only when a scope is given.) A file index written here sits in a different tree from the one `@dreamteamer/files` maintains.

<a id="d3"></a>
### D3 · Ids made from names differ
*Incompatible · Defect · impact medium*

**Closed in `143c57a`.** Accents are stripped as the released engine strips them; the hash for a name with no Latin letters is the released engine's, and the writer is told; a name too long for a file fails in one line.

**README:** "An accented name comes out differently … a name with no Latin letters becomes a ten-character hash, silently."

**Actually:** For plain names, punctuation, apostrophes and slashes the ids match the released engine's (in the review). They differ for accents, where each combining mark becomes a separator (`src/store.ts:120`), and for names with no Latin letters.

```
$ dtx add users --name "Zoë Brontë-Ångström"
✔ users/zoe-bronte-a-ngstro-m · …
$ rel add users --name "Zoë Brontë-Ångström"
✔ R · data/users/zoe-bronte-angstrom.user.md
$ dtx add users --name "Ελένη Παπαδοπούλου"
✔ users/c035f42cbc · …
$ rel add users --name "Ελένη Παπαδοπούλου"
✔ R · data/users/x0n36jsv.user.md
⚠ id "x0n36jsv" is a hash, not a name — "name" (Ελένη Παπαδοπούλου) has no latin characters to slug.
```

A name of some 330 characters ends in a stack trace here (`ENAMETOOLONG`, in the review); the released engine fails on it too, with one line.

**Impact:** The same person gets a different id in each engine, and a reference written by hand from the name does not resolve. The user is not told that an id is a hash.

<a id="d4"></a>
### D4 · `created` is UTC and the id takes the UTC day
*Incompatible · Defect · impact medium*

**Closed in `143c57a`.** `created` is local time with its offset, and a date in an id is read from the value as written.

**README:** "The date in an id is the UTC day, not the local one".

**Actually:** `created` is `new Date().toISOString()` (`src/store.ts:141`), and the `date` filter takes its first ten characters.

```
$ TZ=America/Los_Angeles date +%F
2026-11-16
$ TZ=America/Los_Angeles dtx add tasks --name "Evening errand"
✔ tasks/2026-11-17--evening-errand · …
```

The released engine stamps local time with its offset — `created: '2026-11-17T03:47:47+02:00'` in the side-by-side workspace — and dates the id from that.

**Impact:** For part of every day a record's id is dated the day before or after the user's own date, and the two engines give the same record different ids. A date appears 22 times in the id rules of the published collections.

<a id="d5"></a>
### D5 · One value for a list field is stored as a single value
*Incompatible · Defect · impact medium*

**Closed in `143c57a`.** A list field always holds a list, and one value is split on commas.

**README:** "One value given to a list field is stored as a single value, not as a one-item list, and a comma-separated value is not split."

**Actually:**

```
$ dtx add tasks --name "Pay rent" --tags home && grep tags data/tasks/*--pay-rent.task.md
tags: home
$ dtx add tasks --name "Two tags" --tags home,errand
✖ tasks/2026-11-17--two-tags rejected — nothing written
  tasks/2026-11-17--two-tags: tags: does not match ^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$
```

Validation accepts the single value, because one value in a `many` field is treated as a list of one (`src/store.ts:90`). The released engine writes a list in both cases; D6 shows its `tags` for one value.

**Impact:** The same field is a list in one record and a string in the next, so anything that reads the files must handle both. The comma form that published skills use fails, or stores one wrong element.

<a id="d6"></a>
### D6 · The same input produces a different file
*Incompatible · Defect · impact low*

**Closed in `143c57a`.** `add` writes the given fields, then `created`, then the defaults, quotes dates, and ends a body with a newline. One difference remains: a string that needs quoting gets double quotes where the released engine uses single ones.

**README:** "The two engines write the same record differently".

**Actually:** The same `add tasks --name "Call the bank" --assignee users/dana-oren --tags finance`, in the side-by-side workspace:

```
# this version                          # the released engine
---                                     ---
created: 2026-11-17T01:47:46.777Z       name: Call the bank
status: suggested                       assignee: users/dana-oren
urgent: false                           tags:
confidence: normal                        - finance
name: Call the bank                     created: '2026-11-17T03:47:47+02:00'
assignee: users/dana-oren               status: suggested
tags: finance                           urgent: false
---                                     confidence: normal
                                        ---
```

The same defaults are filled in. The order of keys, the form of `created` and the list differ. A body given on the command line is also written without a final newline here:

```
$ dtx add recipes --name "Toast" --steps "Toast the bread." && tail -c 18 data/recipes/toast.recipe.md | xxd
00000000: 2d0a 546f 6173 7420 7468 6520 6272 6561  -.Toast the brea
00000010: 642e                                     d.
```

**Impact:** Each engine reads the other's file — in the review, apart from the cases in D1, D8 and D11. But a workspace edited by both shows churn in every diff, and a file without a final newline trips editors and linters.

<a id="d7"></a>
### D7 · A rewrite restyles the frontmatter and drops comments
*Partial · Defect · impact medium*

**Closed in `143c57a`.** `set` rewrites only the lines of the keys it changes; comments and blank lines between keys stay where they are. If the edited text would not read back as the fields intended, the frontmatter is written afresh.

**README:** "The values survive. Comments in the frontmatter do not, and quoting and folding change".

**Actually:** A hand-written record, then a one-field `set`:

```
$ dtx set users/sam-diaz status=inactive && git diff
 ---
-# joined through the Northwind referral
-name: "Sam Diaz"
+name: Sam Diaz
 kind: human
-status: active
-created: '2026-11-01T09:00:00+02:00'
+status: inactive
+created: 2026-11-01T09:00:00+02:00
 ---
```

The released engine, on a record written the same way, keeps the comment and the quoting, changes the one line, fills in a default and removes the blank line above the body:

```
$ rel set users/lena-park status=inactive && git diff
 # joined through the Northwind referral
 name: "Lena Park"
 kind: human
-status: active
+status: inactive
+confidence: normal
 ---
-
 Prefers mornings.
```

In the review every record of the real workspace was rewritten here without changing anything: 4,694 were written, and the bytes changed in 4,684 of them. An independent parser found no value and no body changed in any. A value-preserving `set` in the released engine left 41 of 55 records byte-identical.

One loss is shared by both engines: in a Markdown collection that declares no `body: true` field, text below the frontmatter is not read, and a `set` removes it (in the review).

**Impact:** The data is safe. A one-field change produces a multi-line diff, a human's note in the frontmatter is gone, and in a workspace whose audit trail is the git log that buries the real change.

<a id="d8"></a>
### D8 · Reverse fields are not maintained, and the released `check` then fails
*Incompatible · Scope boundary · impact high*

**README:** "Generated reverse fields (`mirror_of`) are neither produced nor checked (Planned) … the released engine's `check` then reports that field as stale."

**Actually:** `@dreamteamer/tasks` gives `users` a `tasks` field, the reverse of `tasks.assignee`. The released engine fills it on every write; this version skips such fields (`src/store.ts:89`).

```
$ dtx add users --name "Dana Oren" && dtx add tasks --name "Call the bank" --assignee users/dana-oren
$ rel check                                             # the same workspace
✖ data/users/dana-oren.user.md
    tasks: stale — run: dreamteamer relations rebuild users
1 violation. files were NOT modified.
```

After the same two commands in the released engine, the user's file holds `tasks: [tasks/2026-11-17--call-the-bank]`, and this version reads that workspace without error.

**Impact:** Every write here that sets a reference with a reverse side leaves the released engine's `check` red until someone runs `relations rebuild`. 69 published fields are such mirrors. "What is assigned to this person" cannot be read from the person's record. Validation also skips such fields altogether, which on the real workspace includes 338 references into the one collection of [D1](#d1).

<a id="d9"></a>
### D9 · `rm` protects nothing
*Partial · Defect · impact high*

**Closed in `143c57a`.** `rm` refuses a record that others reference, and a folder-shaped record that holds any other record inside its folder; `--force` overrides both.

**README:** "`rm` does not look for records that point at the one it removes … For a folder-shaped record it deletes the whole folder, whatever else is in it".

**Actually:** The released engine refuses to delete a record that others reference, unless forced. This version deletes it.

```
$ rel rm users/dana-oren
✖ users/dana-oren is referenced by:
  data/tasks/2026-11-17--call-the-bank.task.md
fix the references or pass --force. nothing was removed.
$ dtx rm users/dana-oren
✔ removed users/dana-oren
$ dtx check
✖ tasks/2026-11-17--call-the-bank: assignee: broken reference users/dana-oren
```

For a folder-shaped record it removes the folder recursively (`src/store.ts:157`), with whatever is inside:

```
$ find data/albums -type f
data/albums/blue-record/album.md
data/albums/blue-record/cover.txt
data/albums/blue-record/tracks/opening.track.md        # a record of another collection
$ dtx rm albums/blue-record
✔ removed albums/blue-record
$ find data/albums
data/albums
```

The released engine refuses that delete, because the track references the album. In the review it also refused when the inner record was placed there by `storage.under`. Without either, both engines delete a folder record's contents — nested records and other files such as `cover.txt` — without listing them.

**Impact:** A delete is the easiest way to break other records, and here nothing guards it. With a folder-shaped collection — artifacts, design systems — one `rm` can also delete records of another collection that were stored inside.

<a id="d10"></a>
### D10 · System collections are not records
*Missing · Scope boundary · impact medium*

**README:** "the 202 records of the eight system collections … which are not stored as record files".

**Actually:** On the real workspace the released `list` returns 3 agents, 54 collections, 43 command bindings, 30 commands, 2 mixins, 22 modules, 21 skills and 27 UI views, projected from what it compiled. This version loads the same eight descriptors as ordinary collections whose storage paths point at the workspace root, where nothing is, and returns 0 for each. `dtx modules` and `dtx collections` print two of the eight in a format of their own.

**Impact:** "Which skills does this workspace have" is not a `list`, and a reference into a system collection cannot resolve. A tool written against the released engine's record interface gets empty answers.

<a id="d11"></a>
### D11 · Binary records are refused; owner-folder storage is ignored
*Missing · Scope boundary · impact medium*

**README:** "Binary storage is refused, and `check` says it has not checked such a collection. Records kept inside their owner's folder (`storage.under`) are not supported."

**Actually:**

```
$ npm install --save-exact @dreamteamer/assets@0.1.0 && dtx list assets
✖ assets: binary storage is not supported by this experiment
$ dtx check | tail -1
2 records · 5 collections · 4 modules · 0 errors · 8 warnings
```

When this was found `check` skipped a binary collection without saying so; since `143c57a` it prints a warning that the collection's files are not checked. In the review, a collection declaring `storage.under` had its record written to the collection's own folder, and a record placed in its owner's folder by the released engine was not listed. None of the 54 published collections uses `storage.under`.

Markdown, YAML and JSON records, an explicit suffix, nested ids and folder-shaped records all behaved as in the released engine for `add`, `get`, `set` and `list` (in the review).

**Impact:** Icons, logos and avatars from `@dreamteamer/assets` cannot be read or written, and a passing `check` says nothing about them.

<a id="d12"></a>
### D12 · `list` ignores flags it does not know; `get` prints another format
*Incompatible · Defect · impact high*

**Partly closed in `143c57a`.** `list` takes `--filter` and `--json`, and refuses a flag it does not know. It has no sort, and `get` still prints JSON in a shape of its own.

**README:** "It takes no filter, sort or format, and a flag it does not know … is ignored without a word".

**Actually:** Any `--flag value` is parsed as a field (`src/cli.ts:16`), and `list` does not look at fields.

```
$ rel list tasks --filter status=todo                   # one task, with status suggested
(no tasks matching)
$ dtx list tasks --filter status=todo
2026-11-17--call-the-bank                               # exit 0
```

`--sort` and `--json` are ignored in the same way. `get` prints JSON where the released engine prints YAML, and its `--json` is a different shape: `{ref, collection, id, path, data, mtimeMs}` with an absolute path, against the released engine's flat fields with `id`, `$file` and `$repo`.

**Impact:** An agent that asks for the tasks in one state gets every task, with nothing to tell the answer apart from a filtered one, and may act on all of them. Scripts that parse `get --json` break.

<a id="d13"></a>
### D13 · Twenty-six released verbs have no counterpart
*Missing · Scope boundary · impact high*

**README:** "Nine verbs, against thirty-three in the released engine."

**Actually:** From the released `help`, without the verbs that extensions add:

| Group | Released | Here | Absent |
|---|---|---|---|
| Record verbs | 15 | `list` `get` `add` `set` `rm` | `rename` `reorder` `values` `history` `diff` `revert` `next` `relations` `relocate` `resolve` |
| Schema verbs | 6 | none | `add-field` `set-field` `rm-field` `rename-field` `rename-value` `fmt` |
| Workspace verbs | 12 | `check` `compile` | `init` `install` `update` `setup` `doctor` `status` `exports` `changes` `commit` `help` |

Two verbs here are new: `modules` and `collections`. Each absent verb prints the usage line and exits 2.

**Impact:** The losses that change daily use: `rename` (a record's id is fixed once written, since nothing rewrites the references to it), `resolve` (a field holding `${env:NAME}/…` is stored and never rendered into a path), `next` (no answer to "what applies to this record now"), `commit` and `changes` ([G1](#g1)), and every schema verb (a field is added by editing YAML by hand).

<a id="d14"></a>
### D14 · Clearing a field that has a default leaves it absent
*Incompatible · Defect · impact low*

**Closed in `143c57a`.** Clearing a field that has a default puts the default back.

**README:** "An empty value clears a field; a default is not put back".

**Actually:**

```
$ dtx set tasks/2026-11-17--buy-milk status= && grep -c '^status' data/tasks/2026-11-17--buy-milk.task.md
0
$ rel set users/dana-oren status= && grep '^status' data/users/dana-oren.user.md
status: active
```

**Impact:** Minor. The same command leaves the field missing in one engine and at its default in the other.

## Validation and check

<a id="v1"></a>
### V1 · `check` passes over files it does not recognise
*Partial · Defect · impact high*

**Closed in `143c57a`.** `check` warns about every file in a collection's folder that is not one of its records.

**README:** "`check` reads the files whose names it recognises; any other file in a collection's folder is passed over in silence."

**Actually:** A file is a record only if its name ends in the suffix this version expects.

```
$ printf -- '---\nname: Ana\nkind: nonsense\n---\n' > data/users/ana.person.md
$ dtx list users
dana-oren
$ dtx check | tail -1
2 records · 4 collections · 3 modules · 0 errors · 9 warnings
```

The released engine warns about each such file — D1 shows the line. On the real workspace this is how 131 records went unchecked.

**Impact:** A clean `check` does not mean every file in `data/` is valid. A record with a misspelt suffix or extension disappears from lists and from references with no hint why.

<a id="v2"></a>
### V2 · Dates and times are barely checked
*Partial · Defect · impact high*

**Closed in `143c57a`.** A date must be a real date, and a date and time must carry a zone.

**README:** "A `date` is checked for its shape only, and a `datetime` for whether JavaScript can parse it".

**Actually:** A date is matched against four digits, two, two (`src/store.ts:66`). A date-time is anything `Date.parse` accepts (`src/store.ts:67`), although the message for a bad one says "expected an ISO 8601 timestamp".

```
$ dtx add tasks --name "Bad date" --due 2026-13-45
✔ tasks/2026-11-17--bad-date · …
$ dtx add tasks --name "Bad time" --start "March 5"
✔ tasks/2026-11-17--bad-time · …
$ dtx check | tail -1
4 records · 4 collections · 3 modules · 0 errors · 9 warnings
$ rel add tasks --name "Bad date" --due 2026-13-45
✖ validation failed:
  field due: "2026-13-45" must match format "date"
```

**Impact:** Records with impossible dates are written and pass `check`. Sorting, schedules and due-date logic receive them, and the released `check` then rejects them.

<a id="v3"></a>
### V3 · Rules in a descriptor that are not enforced
*Missing · Scope boundary · impact high*

**Partly closed in `143c57a`.** `url` and `email` formats, `minimum`, `maximum`, `minLength`, `maxLength` and `soft` are enforced. The contents of an `object` or a `map`, `unique` and `constraints` are not.

**README:** "Not enforced: the format of a `url` or an `email`, the contents of an `object` or a `map`, numeric bounds and lengths, uniqueness, soft references, and a collection's cross-field `constraints`."

**Actually:**

```
$ cat > modules/home/collections/shops.collection.yaml <<'EOF'
name: shops
storage: { path: data/shops, format: md }
fields:
  name: { type: string, required: true }
  site: { type: url }
  mail: { type: email }
  floors: { type: integer, minimum: 1 }
  address: { type: object, fields: { zip: { type: string, pattern: '^\d{5}$' } } }
EOF
$ dtx add shops --name "Corner shop" --site "not a url" --mail "nobody" --floors -3 --address '{zip: abc, planet: Mars}'
✔ shops/corner-shop · …/data/shops/corner-shop.shop.md
```

And with a published module — `@dreamteamer/projects` requires a decision made by a person to carry its alternatives, rationale and reversibility:

```
$ rel check                                             # a decision with decided_by: person and none of the three
    field (root):  must have required property 'alternatives'
    field (root):  must have required property 'rationale'
    field (root):  must have required property 'reversibility'
    field (root):  must match "then" schema
4 violations. files were NOT modified.
$ dtx check | tail -1
1 records · 17 collections · 5 modules · 0 errors · 11 warnings
```

Across the published descriptors these keys go unenforced: `constraints` in 5 collections, `minimum` on 13 fields, `maxLength` on 1, nested `fields` on 12 objects, `values` on 2 maps, `unique` on 2 fields and `soft` on 2. In the review the released engine rejected each of the cases above, and this version also accepted a list where an `object` or a `map` is declared.

**Impact:** Records that break a module's own rules are written and pass `check`. The released engine then reports them, so a workspace can go red without anyone having changed it.

<a id="v4"></a>
### V4 · Stricter than the released engine in three places
*Incompatible · Defect · impact medium*

**Closed in `143c57a`.** A quoted number or boolean, a one-item list where one value is expected, and a required field holding `null` are accepted, as by the released engine.

**README:** "In a few cases it is stricter than the released engine".

**Actually:** The released engine coerces a quoted number or boolean, and a one-item list given to a single-value field. It also accepts a required field holding `null` or an empty string. This version rejects all of them.

```
$ printf -- "---\nname: Call the bank\nurgent: 'true'\n---\n" > data/tasks/2026-11-17--call-the-bank.task.md
$ rel check
✔ 0 violations (32 records across 13 collections)
$ dtx check
✖ tasks/2026-11-17--call-the-bank: urgent: expected true or false
```

It is also louder about a dependency that is declared and not installed: an error and exit 1 here, silence in the released engine (in the review).

**Impact:** Hand-written or script-written records that pass the released `check` can fail this one. Not seen on the real workspace; nothing prevents it elsewhere.

<a id="v5"></a>
### V5 · None of the checks that extensions and the released engine add
*Missing · Scope boundary · impact medium*

**README:** "`check` … covers less than the released `check` does."

**Actually:** The released `check` runs "every installed extension's own checks" after its own (`help`). On the real workspace it prints ten warnings that come from `@dreamteamer/rnd`; this version prints none. In the review a release record whose version no longer matched its id passed here and was a violation there.

From the released engine's source, in the review, these checks also have no counterpart: the same id twice in one collection, stale reverse fields ([D8](#d8)), records in the wrong folder for their owner, unrecognised files ([V1](#v1)), record layers and the exports manifest, the navigation document, and a warning that the compiled state is stale.

**Impact:** The rules a module adds through its extension — one release per version, lifecycle-stage consistency — stop running without notice.

## The command line

<a id="c1"></a>
### C1 · Ordinary text is refused or crashes, because values are parsed as YAML
*Partial · Defect · impact high*

**Closed in `143c57a`.** A value is converted by the declared type of its field; text is never parsed as YAML. Test: "text is stored as it was typed", fifteen titles.

**README:** "Text that looks like YAML is not treated as text. Some of it is refused with a message that does not say why … Some of it crashes".

**Actually:** Every value goes through a YAML parser (`src/cli.ts:9`), whatever the field's type.

```
$ dtx add tasks --name "Re: budget"
✖ tasks/2026-11-17--object-object rejected — nothing written
  tasks/2026-11-17--object-object: name: expected a string
$ dtx add tasks --name 2026
  tasks/2026-11-17--2026: name: expected a string
$ dtx add tasks --name "#1 priority"
  tasks/2026-11-17--null: name: required
$ dtx add tasks --name "[draft] plan"
                this.errors.push(new errors.YAMLParseError(pos, code, message));        # a stack trace
$ dtx add tasks --name '"Re: budget"'                   # the workaround: quote it twice
✔ tasks/2026-11-17--re-budget · …
```

`'@dana review'` and `'"quoted" title'` crash in the same way. The released engine stores each of these as the text it was given:

```
$ rel add tasks --name "Re: budget" && rel add tasks --name "[draft] plan" && grep -h '^name' data/tasks/*
name: '[draft] plan'
name: 'Re: budget'
```

In the review, of 20 such titles the released engine stored all 20; this version refused 11 and crashed on 9.

**Impact:** Email subjects, years, bracketed tags and mentions cannot be written without a second pair of quotes. An agent sees a wrong explanation or a stack trace and retries. Nothing wrong is written in these cases; C2 is where something is.

<a id="c2"></a>
### C2 · Some text is silently changed or erased, for the same reason
*Partial · Defect · impact high*

**Closed in `143c57a`.** The same change: `#`, `null`, `~` and line breaks are kept as text, and only an empty value clears a field. Test: "a body that starts with a heading, or spans lines, is kept".

**README:** "Some of it is changed without a word. A `#` that starts a value, or follows a space inside it, begins a comment … A line break inside a value becomes a space."

**Actually:** `#` starts a YAML comment, at the start of a value or after a space inside it. What follows is dropped; if nothing is left the value parses as empty, and `set` treats an empty value as "clear this field" (`src/store.ts:150`).

```
$ dtx add recipes --name Soup --steps "Chop. Simmer." && tail -1 data/recipes/soup.recipe.md
Chop. Simmer.
$ dtx set recipes/soup 'steps=# Method'
✔ recipes/soup · …/data/recipes/soup.recipe.md          # exit 0
$ tail -1 data/recipes/soup.recipe.md
---                                                     # the body is gone, and nothing replaced it
$ dtx set recipes/soup steps=$'Chop the onions.\nSimmer for an hour.' && tail -1 data/recipes/soup.recipe.md
Chop the onions. Simmer for an hour.
$ dtx add tasks --name "Tagged" --creation_context "#urgent fix" && grep creation_context data/tasks/*--tagged.task.md
creation_context: null
$ dtx add tasks --name "Fix issue #42" && grep '^name' data/tasks/*--fix-issue.task.md
name: Fix issue
$ dtx set recipes/soup steps=null && tail -1 data/recipes/soup.recipe.md
---                                                     # the word null erases the body too, and so does ~
```

The released engine, given `set users/sam-diaz 'notes=# Profile'`, makes the body `# Profile`.

**Impact:** Data loss reported as success. Markdown bodies commonly begin with a `#` heading, and a multi-line value written through the CLI loses its line structure.

<a id="c3"></a>
### C3 · Flags are not read the way the released engine reads them
*Incompatible · Defect · impact medium*

**Closed in `143c57a`.** `--field=value` and a bare boolean flag are understood; a flag the verb does not know is refused; a flag before the verb is an error with exit 1.

**README:** "A flag always takes the next word as its value. `--name=value` and a flag with no value are not understood."

**Actually:** (`src/cli.ts:16`)

```
$ dtx add recipes --name=Equals --serves=3
✖ recipes: cannot make an id — pass --id or the fields {{ name | slug }} needs
$ dtx add tasks --urgent --name "Flagged"
✖ tasks: cannot make an id — pass --id or the fields {{ created | date }}--{{ slug }} or … needs
$ dtx add recipes --name --draft
✔ recipes/draft · …                                     # the name is "--draft"
$ dtx --strict check; echo $?
dt modules | collections | list <collection> | …        # the usage line: nothing was checked
0
$ rel add tasks --urgent --name "Flagged" && grep urgent data/tasks/*flagged*
urgent: true
$ rel add tasks --name=Equals
✔ R · data/tasks/2026-11-17--equals.task.md
```

**Impact:** Commands that are valid for the released engine fail with a message about ids, or write a field the user did not name. A flag placed before the verb swallows the verb and exits 0, so a script that runs `dtx --some-flag check` sees a pass for a workspace that was never checked.

<a id="c4"></a>
### C4 · `set` with nothing to set reports success
*Partial · Defect · impact medium*

**Closed in `143c57a`.** `set` with nothing to set, or with a field the collection does not have, is refused.

**README:** "`set` with nothing to change still reports success."

**Actually:** `set` with no pairs, or with a pair it cannot parse — a dotted key, for one — rewrites the file and prints the success line.

```
$ dtx set users/dana-oren
✔ users/dana-oren · …/data/users/dana-oren.user.md      # exit 0
$ dtx set users/dana-oren notes.first=x
✔ users/dana-oren · …/data/users/dana-oren.user.md      # exit 0, nothing changed
$ rel set users/dana-oren
✖ nothing to set — pass key=value pairs or --key value flags
```

**Impact:** An agent believes an update happened. Where the file was written by another tool, the rewrite also restyles it ([D7](#d7)).

<a id="c5"></a>
### C5 · Short forms from the released documentation do not work
*Incompatible · Scope boundary · impact medium*

**Closed in `143c57a`.** The singular, authored or inflected, names a collection in any verb and in a reference; one bare argument on `add` is the title; a bare id is completed for a field that points at one collection.

**README:** "A collection may be named in the singular for `list` and `add` … A reference is always spelled in full."

**Actually:**

```
$ dtx get user/dana-oren
✖ user/dana-oren: not a <collection>/<id> reference
$ dtx add task "Call the bank"
✖ tasks: cannot make an id — pass --id or the fields …
$ dtx add tasks --name "Call the bank" --assignee dana-oren
  tasks/2026-11-17--call-the-bank: assignee: expected a users/<id> reference
$ dtx add company --name Fabrikam
✖ unknown collection company
```

The released engine accepts all four: `get user/dana-oren`, `add task "Call the bank"`, `--assignee dana-oren` (stored as `users/dana-oren`) and `add company`.

**Impact:** Commands copied from the released documentation or from a published skill fail. The singular works only where dropping an `s` happens to be right.

<a id="c6"></a>
### C6 · Mistakes and damaged files end in stack traces
*Partial · Defect · impact medium*

**Closed in `143c57a`.** Every failure is caught and printed as one line; a damaged record is reported as unreadable and can still be removed. `DT_DEBUG=1` shows a stack trace.

**README:** "A missing reference for `get`, `set` or `rm`, or a record that cannot be parsed, ends in a stack trace instead of a message."

**Actually:** Only the engine's own error type is caught (`src/cli.ts:48`).

```
$ dtx get
TypeError: Cannot read properties of undefined (reading 'startsWith')
$ dtx list
✖ unknown collection undefined
$ printf -- '---\nname: [unclosed\n---\n' > data/users/bad.user.md
$ dtx get users/bad                                     # set and rm likewise
                this.errors.push(new errors.YAMLParseError(pos, code, message));
$ dtx check
✖ users/bad: Flow sequence in block collection must be sufficiently indented and end with a ] at line 1, column 16:
$ rel get
✖ dt get needs a target — see `dreamteamer help`
```

`check` reports a record it cannot parse as an error, as the released engine does. In the review it aborted with a stack trace, and no summary line, on a subfolder it could not read. A record with broken YAML cannot be removed with `rm`. Also in the review: a malformed `package.json`, in the workspace or in any module, crashes every verb with a `SyntaxError`, where the released engine skips that module; and a directory named like a record file is listed as a record and crashes `get`, `set` and `rm`.

**Impact:** One bad file prints Node internals that an agent may read as an engine crash, and has to be deleted by hand.

<a id="c7"></a>
### C7 · The engine calls itself `dt`, has no `help`, and explains less
*Partial · Defect · impact low*

**Closed in `143c57a`.** `help` and `--version` exist; the generated instructions say how to run this engine; an unknown field gets a suggestion and the list of fields.

**README:** "There is no `help` verb and no `--version`."

**Actually:** `dtx help` prints the usage line and exits 2, as for any unknown verb. `dtx --version` takes the next argument as its value and prints the usage line. The usage line names the command `dt`.

In the review its rejection messages were as clear as the released engine's for a bad enum value, a bad date and a broken reference. They were weaker for a misspelt field — no suggestion, where the released engine says "did you mean --assignee?" — and for a missing title, where it talks about id templates when the fix is to pass a name.

**Impact:** An agent corrects itself more slowly from these messages for the two commonest mistakes.

## Compile and agent instructions

<a id="a1"></a>
### A1 · Nothing delivers the instructions to an agent harness
*Missing · Scope boundary · impact high*

**README:** "Nothing loads these files for you yet" (Planned).

**Actually:** In the side-by-side workspace the released `compile` has written four folders and three root files — `.dreamteamer/`, `.claude/`, `.agents/`, `.cursor/`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` — holding 83 files in the folders alone. This version writes 3 files, in `.dt/`. On the real workspace the figures are 362 files and 2.9 MB against 3 files and 0.4 MB.

No harness was run for this report. That none of them reads `.dt/AGENTS.md` rests on their documented conventions: each loads files at the workspace root or in its own folder.

**Impact:** The central idea of DreamTeamer — the schema reaches every conversation — does not happen here unless a person tells the agent where to look. The agent also gets no skills, slash commands or agents in the form its harness loads.

<a id="a2"></a>
### A2 · The instruction file does not carry enough to write a record
*Partial · Scope boundary · impact high*

**Closed in `143c57a`.** The entry for a collection now gives its id rule and every field with its type, allowed values and default.

**README:** "It names each collection's required fields only".

**Actually:** The entry for `tasks`, from each engine, in the same workspace:

```
# the released engine's AGENTS.md
- tasks — A concrete commitment, starting with a verb — …
    use when: …
    write: required name; status enum(6) · confidence enum(3); e.g. tags='client:northwind', author='agents/claude-code'

# this version's .dt/AGENTS.md
- **tasks** (@dreamteamer/tasks) — A concrete commitment, starting with a verb — …
  use when: …
  stored: data/tasks · required: name
```

The model behind it has 20 fields. Where a module ships command bindings, the released file also has a section saying which commands apply to which collection, which this one cannot have ([M4](#m4)).

**Impact:** An agent that reads only the instruction file knows that tasks exist and need a name. It does not know about `assignee`, `due` or `status`, what values are allowed, or what an id looks like.

<a id="a3"></a>
### A3 · Skills have no path, and the pointers lead to the other engine
*Partial · Defect · impact medium*

**Closed in `143c57a`.** Each skill is listed with its path, and the file opens with the command that runs this engine. Where the released engine's package is installed, its own `using-dreamteamer` skill is still listed.

**README:** "… followed by the skills the installed modules ship."

**Actually:** Each skill is a name and a description. `grep -c SKILL.md .dt/AGENTS.md` prints 0: the path is only in `model.json`, and nothing copies a skill to where a harness looks. Both engines find the same 21 skills on the real workspace.

The file opens with "Use `dt list|get|add|set|rm|check`". Nothing installs a `dt` for this version, and in a workspace that has the released engine, `dt` is the released engine. Where the engine's own package is installed, the list includes its `using-dreamteamer` skill, which teaches `commit`, `next` and `changes` — verbs this version does not have.

**Impact:** An agent that follows the generated instructions literally runs a command that is missing, or runs the other engine, and is pointed at documentation for verbs that will fail.

<a id="a4"></a>
### A4 · `model.json` holds absolute paths
*Partial · Defect · impact low*

**Closed in `143c57a`.** `model.json` holds paths relative to the workspace; a test compiles a moved copy and compares the two.

**README:** "`.dt/model.json` holds absolute paths, so it is not the same on two machines."

**Actually:** In the walkthrough workspace the absolute path of the workspace appears 5 times: the root, each module's folder and each skill's file. Two compiles in one place are byte-identical; the same workspace copied elsewhere gives an identical `AGENTS.md` and a different `model.json` (in the review). The test that calls compile reproducible compiles twice in the same folder.

**Impact:** The file cannot be compared between machines or shared, and it records where on a disk a person keeps their work.

<a id="a5"></a>
### A5 · Nothing reports stale instructions
*Missing · Scope boundary · impact low*

**README:** "Nothing tells you it is stale."

**Actually:** After a descriptor gains a required field, validation follows at once and the instruction file does not:

```
$ dtx compile                                           # then add a required `source` field to recipes
$ dtx add recipes --name Toast
✖ recipes/toast rejected — nothing written
  recipes/toast: source: required
$ grep -A1 'recipes\*\*' .dt/AGENTS.md | tail -1
  stored: data/recipes · required: name
```

The released engine has the opposite problem and says so: it goes on validating against what it last compiled, and prints `⚠ .dreamteamer is stale (1 source(s) differ)`.

**Impact:** An agent can be told an out-of-date schema with no signal. No command can be wrong because of it, since none reads `.dt/`.

## Commits and Git

<a id="g1"></a>
### G1 · No `commit`, `changes`, `history`, `diff` or `revert`
*Missing · Scope boundary · impact medium*

**README:** Planned: "`commit <ref>…`, one explicit verb that stages exactly the records you name and commits them" … "whether the history, diff and revert of a record become verbs or stay plain git" is Open.

**Actually:** `git` appears on two lines of `src/`, both in `compile.ts`: a comment saying it never touches git, and the `.gitignore` it writes. Nothing in `src/` starts another program. In the review, with a logging stand-in for `git` first on the `PATH`, nine verbs made no git call at all.

**Impact:** Scoping a commit to the records one session wrote — the released engine's protection against sweeping up another session's work — is left to the user's `git add`. Nothing prints the list of records a session changed, and nothing stops one side of a relation being committed without the other.

## Safety: containment, concurrency, failure

<a id="f1"></a>
### F1 · `get` and `rm` follow a reference out of the workspace
*Partial · Defect · impact high*

**Closed in `143c57a`.** `get`, `set` and `rm` refuse a reference whose id is empty, has a `.` or `..` segment or starts with a slash, and one that differs from the file's name in case. Test: "a reference or an id cannot reach outside the record it names".

**README:** "`get` and `rm` make no such check: a reference with `..` in it reads or deletes a matching file outside the workspace."

**Actually:** Only `add` and `set` test the path (`src/store.ts:99`). `get` and `rm` join the reference onto the collection's folder and use whatever is there (`src/store.ts:36`, `:155`).

```
$ mkdir -p ../victim/sub && printf -- '---\nname: Victim\n---\n' > ../victim/secret.user.md
$ printf 'victim index\n' > ../victim/index.md && echo keep > ../victim/sub/important.txt
$ dtx get users/../../../victim/secret
{
  "name": "Victim"
}
$ dtx rm users/../../../victim/secret
✔ removed users/../../../victim/secret
$ dtx rm pages/../../../victim                          # pages is folder-shaped, entry index.md
✔ removed pages/../../../victim
$ ls -d ../victim
ls: ../victim: No such file or directory
```

The released engine answers `no such record` to the `get` and `invalid id … no "."/".." segments` to the `rm`.

**Impact:** One mistyped or hostile reference reads a file outside the workspace, or recursively deletes a directory there — any directory that holds a file named like the collection's entry. Anything built on `src/api.ts` that passes on a reference it was given inherits this.

<a id="f2"></a>
### F2 · An empty or `..` id can delete a collection's folder, or all of `data/`
*Partial · Defect · impact high*

**Closed in `143c57a`.** The same guard: an empty id and `..` are refused by every verb, whatever is on disk.

**README:** "An empty id or `..` is not refused."

**Actually:** For a folder-shaped collection the record's path is `<folder>/<id>/<entry>`. With an empty id that is the collection's own folder, and with `..` its parent. If a file with the entry's name happens to sit there, `rm` removes that directory.

```
$ dtx add pages --name Welcome && printf '# about this folder\n' > data/pages/index.md
$ dtx rm 'pages/'
✔ removed pages/
$ ls data
recipes tasks users

$ printf 'readme\n' > data/index.md                     # on a fresh copy
$ dtx rm 'pages/..'
✔ removed pages/..
$ ls
modules node_modules package-lock.json package.json     # data/ is gone
```

Without the stray file both are refused with `no such record`. The released engine refuses both forms as invalid ids, whatever is on disk (in the review).

**Impact:** A README-style `index.md` in a data folder turns an empty id — easy to produce from a script variable that came back empty — into the loss of every record in the workspace.

<a id="f3"></a>
### F3 · An explicit id is not validated
*Partial · Defect · impact high*

**Closed in `143c57a`.** The same guard applies to `--id` on `add` and to the reference given to `set`, so neither can write into another folder or an installed package.

**README:** "An explicit `--id` is checked only against the collection's id pattern, if it has one."

**Actually:** Where a collection declares no pattern, an id with `..` in it writes anywhere inside the workspace; only the workspace root stops it. A reference given to `set` is not checked either until that same root, so it rewrites any matching file inside the workspace — a file of an installed package included.

```
$ dtx add users --name Eve --id ../recipes/eve          # users has a pattern
✖ users/../recipes/eve rejected — nothing written
$ dtx add shops --name Planted --id ../users/planted    # shops has none
✔ shops/../users/planted · …/data/users/planted.shop.md
$ dtx add shops --name Planted --id ../../.git/planted
✔ shops/../../.git/planted · …/.git/planted.shop.md
$ dtx add shops --name Planted --id ../../../escape
✖ ../../../escape: path leaves the workspace
$ dtx add shops --name Abs --id /tmp/abs
✔ shops//tmp/abs · …/data/shops/tmp/abs.shop.md
$ dtx add shops --name Planted --id ../../node_modules/@dreamteamer/tasks/collections/planted
✔ shops/../../node_modules/@dreamteamer/tasks/collections/planted · …/node_modules/@dreamteamer/tasks/collections/planted.shop.md

# the side-by-side workspace, where the engine's own `skills` collection is installed
$ dtx set skills/../node_modules/@dreamteamer/tasks/skills/working-with-tasks description=hijacked
✔ skills/../node_modules/@dreamteamer/tasks/skills/working-with-tasks · …/node_modules/@dreamteamer/tasks/skills/working-with-tasks/SKILL.md
$ grep '^description' node_modules/@dreamteamer/tasks/skills/working-with-tasks/SKILL.md
description: hijacked
```

The files planted with `..` are listed by no collection and seen by no `check`. The absolute id is re-rooted: it is written at `data/shops/tmp/abs.shop.md` and listed as `tmp/abs`, not as the id that was given. An id with spaces in it is accepted too (in the review). The released engine refuses every one of these ids: "ids are relative paths, no "."/".." segments, no leading slash" (in the review, and F1).

**Impact:** A typo, or an id an agent assembled, can drop a file into another collection's folder, into module sources or into `.git/`, where nothing will ever report it, and can change the files of an installed module, which everything else in this engine treats as read-only.

<a id="f4"></a>
### F4 · A descriptor decides where records are read and deleted
*Partial · Scope boundary · impact medium*

**Partly closed in `143c57a`.** A storage path outside the workspace is neither read nor written, and `check` says so; a symbolic link below a collection's folder is not followed. A collection folder that is itself a symbolic link still is, as in the released engine.

**README:** "A module is still trusted input. Its descriptors decide where records are read, written and deleted".

**Actually:** In the review, with a collection whose `storage.path` climbs out of the workspace, `list`, `get` and `check` read the outside records and `rm` deleted one; `add` and `set` were refused. The released engine allowed all of them, writes included. An absolute `storage.path` is re-rooted under the workspace here without a word, where the released engine writes to the absolute path. Both engines follow a collection folder that is a symbolic link to somewhere else.

**Impact:** This version is stricter than the released engine on writes and no stricter on reads and deletes. A descriptor that points at a shared drive on purpose silently writes somewhere else here.

<a id="f5"></a>
### F5 · Two writers on one record: most conflicts are refused, a few updates are lost
*Partial · Defect · impact medium*

**README:** "Under contention most conflicting writes are refused and can be retried, and a few report success and are lost".

**Actually:** Thirty `set` commands started at once on one record, each setting a different field, three runs:

```
$ for i in $(seq -w 1 30); do dtx set counters/target f$i=v$i & done; wait
run 1: exit 0: 21 of 30 · refused 'changed on disk': 9 · values in the file: 20 · lost: 1
run 2: exit 0: 17 of 30 · refused 'changed on disk': 13 · values in the file: 15 · lost: 2
run 3: exit 0: 24 of 30 · refused 'changed on disk': 6 · values in the file: 24 · lost: 0
```

In the review: six runs lost 6 of 133 reported successes, with no corrupted file. The released engine reported 30 of 30 successes each time and lost 82 of 90. Thirty parallel adds of different records all succeeded in both engines. Thirty parallel adds of the same id gave exactly one success here in 8 of 8 runs, where the released engine reported 2 to 5 successes and kept one record.

**Impact:** This version behaves better than the released engine under contention, and still cannot promise that exit 0 means the value is on disk. A caller must be ready to retry a refused write.

<a id="f6"></a>
### F6 · The stale-write check has two open windows and no test
*Partial · Defect · impact medium*

**README:** "It leaves two short windows in which such a change is still overwritten, and it has no test."

**Actually:** The check compares the file's modification time just before the rename (`src/store.ts:111`). In the review, a driver that interposed on the engine's file calls showed it firing when an editor saved between the read and the check, and not firing — `set` reported success and the editor's change was gone — when the editor saved between the check and the rename, or between the read and the reading of the modification time (`src/store.ts:41` and `:49`). `add` has the same gap after its existence test (`src/store.ts:143`).

Each `set` reads the file afresh, so the check never covers an edit made before the command started; there it is not needed, since the change is applied to the file as it then is. The test named "a stale write and a failed set leave the file intact" exercises a rejected `set` and a duplicate `add`, not this check.

**Impact:** The check narrows the window for a lost update and does not close it.

<a id="f7"></a>
### F7 · A crash leaves temporary files that nothing removes
*Partial · Defect · impact low*

**Closed in `143c57a`.** A failed write removes its temporary file. One left by a killed write is reported by `check` and removed by the next write to that record once it is a minute old.

**README:** "A write that is killed part-way leaves a `.tmp` file beside the record, which nothing cleans up."

**Actually:** A write creates `<record>.<pid>.tmp` and renames it (`src/store.ts:108`). In the review, 60 kills during a loop of writes left no truncated or malformed record among 28,065 files, and 17 temporary files, some empty. `list`, `get` and `check` ignore them. They were still there after `check`, `compile` and further writes, and show as untracked files in git.

**Impact:** Records survive a crash intact. Stray files accumulate in `data/`, invisible to `check` and easy to commit by accident.

## Module lifecycle

<a id="l1"></a>
### L1 · Engine floors and peer versions are ignored
*Missing · Scope boundary · impact medium*

**README:** "the engine does not check versions (Open)".

**Actually:** A module that declares `"engine": ">=99.0.0"`:

```
$ rel compile
✖ module @northwind/future needs engine ">=99.0.0" — this is 0.49.1, so none of its content is compiled. Upgrade dreamteamer, or disable the module.
$ dtx modules | grep future
@northwind/future@1.0.0 [npm]
$ dtx add gadgets --name "Pocket lamp"
✔ gadgets/pocket-lamp · …
```

This engine's own version is 0.0.0, and 22 of the 23 published packages on the real workspace's disk declare a floor. In the review an unmet `peerDependencies` range also passed here and failed the released `compile` with the fix spelled out.

**Impact:** A module written for a newer contract is read with this version's narrower semantics, and nothing warns. Version skew between modules goes unreported.

<a id="l2"></a>
### L2 · No upgrade path, and orphaned records go unreported
*Missing · Scope boundary · impact high*

**README:** "upgrades and migrations" (Open).

**Actually:** In the review, a descriptor change that invalidates existing records — a narrowed enum, a removed field, a new required field — produced the same three errors in both engines, here without a compile. When the module was removed and its records stayed, this version counted 0 records and said nothing, where the released engine warned that a folder holds "1 record file no collection here reads". The released engine also has `update`, `status`, `doctor` and module setup; this version has none.

**Impact:** After a module is upgraded, records the new descriptor rejects show up as `check` errors with no word that an upgrade caused them. After one is removed, its records are simply invisible.

## User interface

<a id="u1"></a>
### U1 · No UI, and nothing to draw one from
*Missing · Scope boundary · impact high*

**README:** "Presentational — Planned, with no design yet".

**Actually:** There is no server and no page. The model drops display metadata ([R1](#r1)), orders fields differently ([R3](#r3)), and does not read UI views or navigation ([M4](#m4)).

**Impact:** The released experience of navigating collections beside the agent chat has no counterpart, and the data a UI would need is not yet in the model.

<a id="u2"></a>
### U2 · No live refresh
*Missing · Scope boundary · impact low*

**README:** "live refresh" (Open).

**Actually:** No file watcher and no change feed. Since every command resolves from the files, a reader that re-runs a command always sees current data.

**Impact:** None until there is a UI.

## Tests and API

<a id="t1"></a>
### T1 · The CLI has no automated test; a third of the branches never run
*Missing · Scope boundary · impact medium*

**Closed in `143c57a`.** `test/cli.test.ts` runs the command line as a process. Coverage of `src/` and `bin/` is now 99% of lines and 86% of branches.

**README:** "they execute 98% of the lines and 64% of the branches … No test loads the CLI".

**Actually:**

```
$ node --test --experimental-test-coverage test/*.test.ts
file         | line % | branch % | funcs % | uncovered lines
 api.ts      | 100.00 |   100.00 |  100.00 |
 compile.ts  | 100.00 |    76.92 |  100.00 |
 discover.ts |  97.83 |    50.00 |  100.00 | 44
 model.ts    |  93.00 |    62.79 |   91.67 | 82-85 89-91
 store.ts    |  99.43 |    62.81 |   92.31 | 133
 types.ts    | 100.00 |   100.00 |  100.00 |
all files    |  97.93 |    63.59 |   94.12 |
```

`src/cli.ts` is not in the table because no test imports it. The line figure hides branches that share a line, such as the stale-write rejection.

**Impact:** Every defect in the command-line section, and every one in the safety section, is in code or in a branch that no test runs.

<a id="t2"></a>
### T2 · Nothing in the suite touches a real module
*Missing · Scope boundary · impact medium*

**Closed in `143c57a`.** `test/published.test.ts` runs the engine on eight published packages, installed as development dependencies at exact versions.

**README:** "The runs against real published modules … were made by hand and are not part of the suite."

**Actually:** As described. The fixture in the test suite is two invented modules. There is no CI.

**Impact:** The compatibility figures in the README are a snapshot. Nothing fails when a change breaks them.

<a id="t3"></a>
### T3 · The API is a fraction of the released one
*Missing · Scope boundary · impact medium*

**README:** "It exports `buildModel`, `discover`, … " — thirteen names.

**Actually:** In the review, `src/api.ts` had 13 runtime exports. The released package has 131 under `dreamteamer`, 65 under `dreamteamer/records` and 6 under `dreamteamer/testing`, with type declarations for each. There is no query or filter, nothing relational, no history, no rename, and no test helpers.

**Impact:** A script can create, read, change, delete and validate records, and nothing else. Module authors lose the testing helpers that the released engine's publish check is built on.

## Published modules, one by one

What each of the 21 packages ships, and what this version does with it. "Read" counts collection descriptors, with overlays in brackets. The last column lists what still breaks after `143c57a`; `peer_collections` is now honoured, and is left in the fourth column only where it was when the table was made.

| Package | Read | Skills indexed | Not read | Manifest keys not acted on | Known to break |
|---|---|---|---|---|---|
| `@dreamteamer/artifacts` 0.1.0 | 1 | 0 | — | `peer_collections` | |
| `@dreamteamer/assets` 0.1.0 | 1 | 0 | 1 view | — | Binary: refused ([D11](#d11)) |
| `@dreamteamer/companies` 0.1.3 | 1 | 0 | — | — | |
| `@dreamteamer/contacts` 0.2.0 | 2 (1) | 0 | — | `peer_collections` | |
| `@dreamteamer/core` 0.13.1 | 0 | 0 | navigation | `nav`, `preset` | Its members are not installed ([M1](#m1)) |
| `@dreamteamer/engagements` 0.1.3 | 2 (1) | 0 | 1 command, 1 binding, 1 view | `peer_collections` | |
| `@dreamteamer/files` 0.3.1 | 2 | 1 | 1 command, 1 binding, 2 views, extension | `extension`, `vars` | `files sync` absent ([M5](#m5)) |
| `@dreamteamer/meeting-docs` 0.1.5 | 5 (2) | 2 | 6 commands, 5 bindings, 1 view | — | |
| `@dreamteamer/meetings` 0.4.0 | 2 (1) | 1 | 2 commands, 1 binding, 2 views, 3 scripts | — | |
| `@dreamteamer/metrics` 0.1.0 | 1 | 0 | — | `peer_collections` | |
| `@dreamteamer/projects` 0.4.3 | 6 (2) | 0 | 1 script | `peer_collections` | Constraints on `decisions` ([V3](#v3)) |
| `@dreamteamer/recordings` 0.5.3 | 2 (1) | 2 | 3 commands, 3 bindings, 1 script, extension | `extension`, `env`, `vars` | |
| `@dreamteamer/responsibilities` 0.1.0 | 2 (1) | 0 | — | — | |
| `@dreamteamer/rnd` 0.11.1 | 21 | 10 | 12 commands, 32 bindings, 11 views, 2 agents, 5 scripts, navigation, extension | `extension`, `nav`, `peer_collections`, `ignore` | Lifecycle checks ([V5](#v5)) |
| `@dreamteamer/roles` 0.1.0 | 2 (1) | 0 | — | — | |
| `@dreamteamer/sessions` 0.1.0 | 2 (1) | 1 | 3 commands, 2 scripts, extension | `extension`, `peer_collections`, `vars` | `session` verbs absent ([M5](#m5)) |
| `@dreamteamer/tasks` 0.3.4 | 3 (2) | 1 | 9 views, 1 script | `peer_collections` | Reverse field on `users` not maintained ([D8](#d8)) |
| `@dreamteamer/users` 0.3.0 | 2 | 0 | 1 script | `peer_collections` | |
| `@dreamteamer/web` 0.3.1 | 0 | 1 | 1 command, 2 scripts, extension | `extension` | `web` and `serve` absent |
| `@dreamteamer/workflows` 0.1.3 | 1 | 1 | 1 command, 1 script | `ignore` | |
| `dreamteamer` 0.49.1 (system module) | 9 | 1 | 1 agent, 2 scripts | — | Its collections hold no records here ([D10](#d10)) |

Every package except the engine's own system module declares an engine floor that is not checked ([L1](#l1)). Ten of them also ship scripts under `bin/`, 19 in all, which are not read ([M4](#m4)).

## What is verified

So that the gaps above have a denominator, this is what the README labels Verified, and what stands behind each claim. "In the review" marks a figure measured before `143c57a` and not re-measured since.

| Claim | Stands on |
|---|---|
| Modules are found from npm dependencies and `modules/`, by the same rule as the released engine for direct dependencies | Tests; 22 of 22 modules on the real workspace, with the same 2 dependency-only packages skipped by both. A local copy of an installed module and `disable` differ ([M7](#m7), [M8](#m8)) |
| The published schema resolves field for field | 54 of 54 collections and 940 of 940 fields agree with the released engine's compiled descriptors on every authored field key (in the review); `test/published.test.ts` resolves eight published packages without an error |
| Every data record of a real workspace is seen and accepted | `check` on the real workspace: 4,837 records, 0 errors, 0 warnings; the released engine counts 5,039 with the 202 system records, and also reports no violation |
| It reads the same stored values as the released engine | 4,705 records compared with the released `list --json`: no frontmatter value differs. Bodies were compared for 240 records and were byte-identical (in the review) |
| A record gets the id and the file the released engine gives it | Tests against ids the released engine produced: a meeting in its year and month folder, a release keyed by its product, a change request by its key, an accented name, a name with no Latin letters; the bytes of a task file. In the side-by-side workspace the released engine lists records written here under the same ids |
| An invalid write is rejected before disk | Tests (sixteen kinds of invalid input); in the review, 73 invalid-write cases were run on both engines and none of the 101 refusals wrote anything |
| A reference or an id cannot reach outside the record it names | Test: eight malformed ids against `get`, `set`, `rm` and `add`, with a file outside the workspace left untouched |
| Text on the command line is stored as typed | Test: fifteen titles that the first version refused, crashed on or cut short |
| `rm` refuses to break or take other records | Test: a referenced record, and a folder record holding a record of another collection |
| `set` changes only the lines it was asked to change | Test: a hand-written record with comments, quoting and a body, compared byte for byte |
| `compile` writes only under `.dt/`, and `model.json` is the same wherever the workspace sits | Test: a moved copy compiles to the same bytes |
| Nothing depends on compiled state | With `.dt/` deleted every verb still exits 0; a descriptor edit takes effect on the next command (in the review) |
| The engine never runs git | No `git`, `child_process` or dynamic `import` in `src/`; no git call observed from nine verbs (in the review) |
| A crash does not corrupt a record | 60 kills, 28,065 files, none malformed (in the review) |
| It is not slower | `check` on the real workspace takes about one second in both engines. In the review, `list`, `get`, `add` and `compile` were a quarter to two-thirds faster here |
