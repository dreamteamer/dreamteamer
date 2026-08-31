# One skill — the 0.16.0 consolidation, its blast radius, and what was verified

Written alongside the change that folded `building-dreamteamer` into `using-dreamteamer`. Its job
is to be honest about what breaks for a consumer on upgrade, what every consumer has to do, and
which claims were *verified* on a live workspace rather than reasoned. The verification workspace:
a synthetic clinic vault (5 collections, 1 namespace, 2 modules, ~40 records) compiled against
both engine states.

## 1. Why

Two top-level skills paid two description-budget entries in every consumer harness while one act
(authoring) was only ever reached through the other's routing table. The reference split had gone
patchy — namespaces explained three times, relations three times, "when a view earns existence"
twice — and prose restated CLI syntax that `dt help` documents, two restatements already false.
One skill, two acts, syntax delegated to `help`.

## 2. What breaks, and what to do

| # | consumer state | what happens on upgrade | the move | verified? |
|---|---|---|---|---|
| 1 | an agent with `skills: [skills/building-dreamteamer]` in frontmatter | **compile FAILS**: `✖ compile error: agents/<name>.agent.md: references unknown skill "skills/building-dreamteamer"` | point it at `skills/using-dreamteamer` | ✔ verified — exact message reproduced |
| 2 | prose naming `building-dreamteamer` — a skill body, a command body, your CLAUDE.md | nothing fails; the name dangles as documentation | `grep -rn 'building-dreamteamer' modules/ CLAUDE.md` and reword at leisure | ✔ nothing enforces prose names (by construction) |
| 3 | a deep link to `using-dreamteamer/references/git-events.md` | the file is gone — renamed to its verb | link `references/changes.md` | ✔ file present in staged output |
| 4 | a deep link to `building-dreamteamer/references/<topic>.md` | the folder is gone | same topic file under `using-dreamteamer/references/` (all eight kept their names) | ✔ all present in staged output |
| 5 | stale staged output from 0.15.x | `dt compile` prunes `.claude/skills/building-dreamteamer/` (and every harness mirror) | nothing — compile after upgrade, as always | ✔ pruned on recompile |
| 6 | orientation blocks (CLAUDE.md / AGENTS.md / …) | regenerated: the read-this-first line now says "before working with data or changing what the workspace keeps or does", and the non-claude-code skills index lists one skill | nothing | ✔ both flavors inspected |
| 7 | harness skill-description budget | one entry replaces two | nothing — strictly less budget | reasoned (arithmetic) |

## 3. Prose corrections riding along

The consolidation re-verified every claim against the engine at 0.15.1 and fixed what had
drifted. Worth knowing because the OLD prose said otherwise:

- **`dt help` is complete** — record, schema and workspace verbs all documented. (The old
  records.md claimed schema verbs were absent from it.)
- **`dt changes` diffs per-descriptor storage paths across every repo that holds records**, and
  resolves `--since` shas to dates cross-repo; the old git-events.md described a literal
  `data/ state/` pathspec. `state/` itself is a deprecated convention.
- **Two `--filter` flags do not combine — the last one wins**; compound conditions go in one
  `--where`. Verified live.
- **`options.sort: ''` cannot be written through `schema set-view`** (an empty dotted value
  removes the key) — hand-write it in the source. Verified live.
- **The kanban's grouping option is `group_by`** (snake_case, defaulting to the first enum
  field); an engine doc example previously spelled it `group-by`, which nothing reads.
- **A module is discovered only if its `package.json` carries a `dreamteamer` key** — previously
  stated nowhere; a hand-created module folder without it is silently ignored.
- **A field verb aimed at a module-owned collection** authors a workspace-module overlay and is
  refused by the extends dependency gate — declare the dependency or edit the owning module's
  descriptor. The old prose described the refusal but not the ladder.

## 4. What deliberately did NOT change

- Every reference file kept its name (only `git-events.md` → `changes.md`, renamed to match its
  verb), so topic links inside the skill survived the move unedited.
- `agents/dreamteamer.agent.md` — core's one agent — already referenced `skills/using-dreamteamer`.
- No CLI verb, flag or behavior changed in this release; the consolidation is prose and its
  collateral only.
