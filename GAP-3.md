# Gap report: every module on the first-principles engine

Where the engine stands after the module work that [GAP-MODULES.md](GAP-MODULES.md) planned: what runs, what was
measured and how to re-run it, and what is still missing. Earlier reports: [GAP.md](GAP.md), [GAP-2.md](GAP-2.md),
[GAP-MODULES.md](GAP-MODULES.md), whose "What has changed since" section holds the step-by-step record this report
summarises.

Measured on 2026-11-17 at engine commit `89f0d8d` plus documentation, and on the modules side at the
`experiment/first-principles-web` branch, whose `modules/` folder is byte-identical to the modules repository's
`main` at `67a6f870`. Workspace and repository names are left out; their numbers are kept.

## In one paragraph

All 37 published modules load on this engine, unchanged. A sample workspace of 35 of them and 287 invented records —
a small consultancy's CRM, meetings, tasks, projects, people, R&D, knowledge and the rest — checks with 0 errors and 0
warnings. The DreamTeamer protocol host, `dt web` and the Web UI run on it unchanged: lists, record pages with their
reverse-field tables, edits, history, bound commands and extension notes, verified end to end in a browser. On the
sample, 14 of the 15 module extensions activate (measured once; the script is not committed), and their verbs, checks, `next` lines and notes work. On 76 real workspace repositories
the two engines now agree that 59 are clean, up from 43 (measured; the script is not committed, see below). The engine is 5,880 lines of its 7,000-line budget. What is
missing is the schema-editing operations, the setup and install side of modules, delivery to harnesses other than
Claude Code, and a list of smaller differences below.

## How to re-run every figure

| Figure | Command | Last result |
|---|---|---|
| Engine checks | `npm run typecheck && npm run lint && npm run format:check && npm test` in this repository | all exit 0; 77 tests pass |
| Engine size | `find src bin \( -name '*.ts' -o -name '*.js' \) \| xargs wc -l \| tail -1` | 5,880 |
| Protocol contract | `node scripts/contract.mjs` in the modules branch (engine: `$DT_ENGINE`, else the sibling checkout) | 64 of 90 pass, 26 fail, 0 skipped |
| End to end | `node scripts/e2e-hq.mjs [--browser <dir>]` in the modules branch | 21 of 21 steps pass: 17 over HTTP through `dt web`, 2 on the engine's command line, 1 on the files `compile` wrote, 1 in a headless browser (`--browser`); 20 without it |
| Sample workspace | `node ../node_modules/dreamteamer-first-principles/bin/dt.ts check` in `hq/` | 287 records · 84 collections · 35 modules · 0 errors · 0 warnings |

**Measured, script not committed** — these cannot be re-run from either repository: the 76-repository comparison
(this engine's `check` and each repository's own released `check`, read-only; its scripts enumerate a private
machine), the trail table below, the count of extensions that activate on the sample (14 of 15), the released engine
refusing to run when two extensions claim one verb, and `next` agreeing with the released engine on 200 of 200
binding-and-record verdicts (a test pins the same comparison on the published rnd module's bindings).

## What the end-to-end run proves

`scripts/e2e-hq.mjs` copies the sample workspace to a temporary folder, links the modules and this engine, adds a
record layer, declares the file drives' folders, names Claude Code as the harness, compiles, and starts the unchanged
`dt web`. Each step says how it runs:

- **over HTTP, through `dt web`, with an Edit-level client token (17):** the nav as `hq/nav.yaml` arranges it;
  `presentation`; five lists with their exact counts, one including a record lent by the layer; every collection
  listed and one record of each read (84); a company page with its reverse fields; a filtered list, its limit and its
  order checked; an edit saved to the file; a bad edit refused with the reason; a new record created; a record's
  history with the workspace's commit; the commands bound to a record, with the eligible one (`next`); a note the
  sessions extension contributes; the layer's record listed with its source and read;
- **on the engine's command line (2):** an extension's own verb (`files status`, a drive reported mounted); records
  stored under their owner's folder, written there and found — on a fixture of its own, not on the sample;
- **on the files `compile` wrote (1):** the modules' skills, agents and commands in `.claude/` and the orientation in
  `CLAUDE.md`;
- **in a headless browser, with `--browser` (1):** the UI drawing the nav, the companies list, a company page, the
  contacts list, the meetings list and the change requests.

## The trail

| Step | Engine lines | 76 repositories: errors · both clean | Contract | Sample |
|---|---|---|---|---|
| Before the module work | 2,279 | 21,050 · 43 | — | — |
| Enums written as maps | 2,304 | 7,948 · 46 | — | — |
| System collections, display metadata, compiled layout | 2,834 | 1,578 · 53 | — | 0/0 |
| Engine API for hosts | 4,337 | 1,578 · 53 | 59/90 | 0/0 |
| Validation: objects, maps, unique, constraints | 4,773 | 1,626 · 53 | 59/90 | 0/0 |
| `next` and extensions | 5,019 | — | 59/90 | 0/0 |
| Overlay keys and six verbs | 5,258 | 1,289 · 54 | 59/90 | 0/0 |
| Delivery to Claude Code, staleness | 5,558 | — | 59/90 | 0/0 |
| Record layers, owner folders, binary reads | 5,880 | 130 · 59 | 64/90 | 0/0 |

Across the 76 repositories at the end: both clean 59, only this engine reports errors 8, only the released engine 1,
both 8, unreadable 0; 107,463 records read.

## Things this report states plainly

- **Record counts differ by design.** On the large real workspace this engine counts 4,837 records and the released
  engine 5,039. The 202 are module source records — 54 collections, 22 modules, 21 skills, 2 mixins, 3 agents, 30
  commands, 43 command bindings and 27 UI views — which the released engine counts as records and this one keeps
  apart and does not count. No data record is missing. Both engines report the same 10 warnings for the same 10
  records there, all from the rnd extension.
- **The sample workspace switches the `http` extension off,** because `http` and `web` both claim the `serve` verb;
  the released engine refuses to run at all in that case (measured, not scripted), this one leaves out the later extension with a warning. So
  `http` is not shown running beside `web`. It was shown on its own: on a scratch copy with `web` switched off instead,
  `http`'s `serve` started its REST API on this engine and answered `/api/info` and a list.
- **One sample record was edited to silence a warning:** the delivered change request was tagged `deployed`, which
  rnd's extension check asks for once `deployed_on` is set.
- **The end-to-end run grew, it never shrank.** It was 13 steps over HTTP; the 14 reported once counted the browser
  step. It is now 17 over HTTP, 2 on the command line, 1 on compiled files and 1 in the browser; record layers and
  owner folders, once listed as unsupported, are now exercised — owner folders on a fixture of their own.
- **The released engine's version is what this engine reports through its API** (0.49.1, the system module it ships),
  so modules' engine floors are met; its own package version is 0.0.0.
- **Module code runs.** Extensions are imported and activated for modules the workspace lists; the command line and
  the engine API run git when asked (`commit`, `changes`, `history`, and the API's history, revert and commit).

## Modules

**Columns.** *S* schema loads · *R* records agree with the released `check` where measured · *K* the verbs its skills
and commands name exist · *X* its extension activates and its contributions act · *U* the unchanged protocol host, through `dt web`, lists
its collections and reads a record of each (all 84 collections of the sample, a committed end-to-end step); the browser
draws companies, a company page, contacts, meetings and change requests; edits and creation are checked on
companies. ✔ yes · ◐ partly · ✖ no · — nothing to do.

| Module | S | R | K | X | U | What is still missing |
|---|---|---|---|---|---|---|
| core (preset) | ✔ | ✔ | — | — | ✔ | installing a preset's members (`install`) |
| rnd | ✔ | ✔ | ✔ | ◐ | ✔ | its extension's `setup`; the schema verbs its skills mention for workspace authors |
| search | ✔ | — | ◐ | ◐ | — | `setup`, `status`; its only contribution (`setup`) is ignored |
| tasks | ✔ | ✔ | ✔ | — | ✔ | — |
| contacts, users, companies | ✔ | ✔ | — | — | ✔ | — |
| assets | ✔ | ◐ | — | — | ◐ | writing binary records (`add --from`, file import) |
| files | ✔ | ✔ | ◐ | ◐ | ✔ | `doctor`, `status`; its `setup` and `doctor` contributions |
| meeting-docs | ✔ | ✔ | ✔ | — | ✔ | — |
| recordings | ✔ | ✔ | ◐ | ◐ | ✔ | `install`, `setup`, `status`; its `setup` contribution |
| meetings | ✔ | ✔ | ✔ | — | ✔ | — |
| engagements | ✔ | ✔ | ✔ | — | ✔ | — |
| projects | ✔ | ✔ | ✔ | — | ✔ | — |
| notebooklm | ✔ | ✔ | ◐ | ◐ | ✔ | `add-field`, `set-field`, `doctor`, `export`, `init`, `status`; `harnesses` and `setup` contributions |
| wikis | ✔ | ✔ | ◐ | ◐ | ✔ | `setup`, `status` |
| knowledge, routines, artifacts, metrics, roles, responsibilities | ✔ | ✔ | ✔ | — | ✔ | — |
| workflows | ✔ | ✔ | ◐ | — | ✔ | `install` (installing a shipped workflow) |
| sessions | ✔ | ✔ | ✔ | ◐ | ✔ | `sourceKinds`, `analyze` and `hooks` contributions |
| web | — | — | ✔ | ◐ | ✔ | its `hooks` contribution; it cannot run beside `http` |
| git-identities | — | — | ✖ | ◐ | — | `status`; its `setup` contribution |
| perspective | ✔ | ✔ | ◐ | ◐ | ✔ | `add-field`, `setup`, `status`; `setup` contribution |
| http | — | — | — | ✔ | — | shown alone (see above) |
| proofs | ✔ | ✔ | ✔ | ◐ | ✔ | `sourceKinds`, `analyze` and `orientation` contributions |
| connectors-google-workspace | — | — | ◐ | ◐ | — | `setup`, `install`, `status`, `doctor`; `setup` and `doctor` contributions |
| connectors-linkedin, connectors-macos, docker-workspaces | — | — | ✔ | — | ✔ | — |
| worktrees | — | — | ◐ | ◐ | — | `install`; its `hooks` contribution |
| code | — | — | — | ◐ | — | activates; its verb not exercised |
| ui, protocol | — | — | — | — | ✔ | run unchanged on the engine API; 26 contract cases fail (below) |

*X* is ◐ where the extension activates but a contribution it relies on is ignored; which extensions were run beyond
activating: rnd (`check`), files (`files status`, `files sync`), sessions (`session bind`, `next` lines, notes), web
(`web start`, `status`, `stop` and the host it serves), http (`serve`).

## What is still missing

**Schema editing.** The 26 contract failures are all schema-editing operations — adding, changing, renaming and
removing fields, enum values, collections, modules, UI views and skills, and their dry runs — and the command-line
schema verbs (`add-field`, `set-field` …) are not built either. The Web UI's schema editor therefore cannot save.

**Setting modules up.** `install`, `init`, `update`, `setup`, `doctor` and `status` are not built (the API's `init`
is minimal), and the extension contributions they would drive — `setup`, `hooks`, `harnesses`, `doctor`, `analyze`,
`sourceKinds`, `orientation` — are accepted and ignored. A module's engine floor is not checked.

**Harnesses.** Only Claude Code is delivered to; Codex, Gemini CLI, Cursor and pi are not. The orientation block
leaves out what extensions add (9 lines on the sample). `/CLAUDE.md` is not added to `.gitignore`.

**Record layers and placement.** A clone a layer needs is not followed; the workspace's own `data_path` and the
classic layout are not honoured; a local copy of an installed module does not take its place; `commit` does not
commit inside a layer's clone; `relations rebuild` is not per repository; a layered list is sorted by id, not by root.
Nested ids under an owner and the `relocate` verb are not built. Binary records cannot be written.

**Smaller differences.** Two extensions claiming one verb: the later is left out with a warning, where the released
engine refuses to run. Where several mixins set `storage` or `ids`, the last wins whole. The command line keeps a
datetime's offset and fractions as typed. `rename` does not check the new id against the collection's pattern.
`commit` takes no lock. `changes` has no `--since`. `check` through the engine API names records, not file paths.
The adapter's staleness never reports stale, and `placementKey` is a plain midpoint.

**Measured disagreement left on real data.** Of the 8 repositories where only this engine reports errors, most run
engine 0.43 and hold `stub: true` records in their layers, which 0.43 hid and 0.49.1 reports exactly as this engine
does (confirmed by compiling one of them with 0.49.1 on a scratch copy). One declares in its own module three
collections an installed package also ships (the local-copy rule above). Two references remain in repositories where
both engines report errors.

## Budget

5,880 of 7,000 lines, under the 6,000-line stop set for this work. The engine API adapter is the largest part
(about 1,500 lines); validation took 436, `next` and extensions 246, the six verbs and overlay keys 239, harness
delivery 300, record layers and placement 322. Closing the schema-editing operations and the setup side is estimated
at 600 to 1,200 lines, which the remaining budget does not cover without a decision on what to leave out.
