# before you build — look for it first

The situation: the operator asked for something the workspace does not seem to do, and you are one
`schema add-collection` or one new skill away from making it exist. This reference is the pause
before that. **When the workspace can't do something, look before you build — and when you do find
something, propose concretely, never install or copy silently.** The operator decides what enters
their workspace.

Two people meet in this decision, and only one of them is in the room. The session about to build
(you) experiences exactly one step of the capability's life: creating it, which is also its
cheapest step. The operator owns every other step — compiling it, maintaining it, paying for its
line in the orientation block every session loads, and eventually noticing it drifted or died.
Every rule below is that asymmetry applied.

| the question | read |
|---|---|
| where do I look, and how, concretely | the four places |
| I found something — is that "found"? | what found means |
| how do I put it to the operator | the proposal |
| nothing exists anywhere | build it — in the module that owns the concept (`data-modeling.md` Part III), after proposing (Part II §7) |

This replaced a standalone `discovering-new-capabilities` skill on 2026-07-31, whose premise — "find
and propose an **installable** module" — had been reversed: domain modules are no longer packages you
install. The looking still matters; the taking changed shape.

## why looking wins

- **A duplicate is worse than a gap.** Two collections holding one concept under two names split
  every future search, and neither ever learns what the other knows. A gap at least stays visible.
- **The thing you didn't find still costs you.** Building beside an existing capability means the
  operator now maintains both, and the day they diverge nobody can say which is right.
- **Adoption is mostly deletion.** A found module arrives maximal — collections you don't need,
  skills for accounts you don't have. The work of adopting it is cutting it down, which is far
  cheaper than building up, and keeps the found thing's hard-won trap notes intact.
- **Hard-to-find is its own diagnosis.** When the capability existed and you missed it, the fix is
  a better `description` or `use_when` on the existing entity — not a second entity. The miss you
  just experienced is exactly the retrieval test that description failed.

## the four places, in order

| # | look at | how, concretely | what you get |
|---|---|---|---|
| 1 | **this workspace's own modules** | the orientation block's COLLECTIONS list is already in your context — reread it with the concept's *synonyms* in mind; `.dreamteamer/manifest.yaml` names every module and entry; `dt <collection> --help` and `dt commands <collection>` show the verbs; the skills index shows the techniques | the thing may already exist under a name you didn't guess. This is where misses actually happen, because it is the place you assume you already know |
| 2 | **the `recipes` repo** — reference modules maintained to be **copied and adapted** | read its `using-recipes` skill first; it IS the adoption procedure | a working module with its reasoning attached — descriptors, skills, and the trap notes that each cost someone a day |
| 3 | **a sibling workspace under `projects/`** | read-only; grep its `modules/` for the concept | another vault may have solved it concretely. That is a *reference*, not a source — it holds real personal data, so read the shape, never lift the content |
| 4 | **the engine's own surface** | `dt help` — the complete verb surface, schema verbs included; read it rather than recalling it | the capability may already be a verb (`relations rebuild`, `resolve`, `ensure`) rather than a missing module |

Only after all four: build it, in the module that owns the concept.

## what "found" actually means

Rarely the exact thing. Four outcomes, each with its own move:

| what you found | the move |
|---|---|
| the exact capability, live in this workspace | use it — and if finding it took effort, fix the `description`/`use_when` that made it hard, in the same breath |
| a recipe covering most of it | propose copy-and-adapt (below). Adoption is deletion |
| a partial match — a collection that could grow a field, a skill that covers half the job | propose extending the existing thing, in the module that owns the concept. Growing a field on the right collection beats a new collection every time (`data-modeling.md` Part IX: additive first) |
| a concrete solution in a sibling workspace | read it for shape and traps, rebuild clean with a synthetic cast — never lift records, names, or account details |

## how to propose

Say three things: **what you found**, **what adopting it would cost**, and **what you would delete
from it**. That last one is not politeness — adoption is mostly deletion, and a proposal that skips
it is asking the operator to accept a maximal module sight unseen. Name the `.env` keys, external
accounts and binaries it needs, because a skill whose setup nobody did is a skill that fails at the
worst possible moment.

The shape, at the size it should be:

> Found: `recipes/clinic` ships `health/lab-values` plus an ingest skill for lab-report PDFs.
> Cost: one `.env` key (`FILES_FOLDER`), no binaries, ~300 lines of skill prose in every future
> compile. I would delete: the portal-scraping half (you file PDFs by hand), the `insurers`
> collection (out of scope here), and its example cast. I would keep: the collection, the
> one-value-per-record grain, and the dedupe rule — that last one is the part worth having.

Then stop and let them choose. Copying a recipe in is a one-way door in practice: from that moment
the copy is theirs to maintain, and nothing will later tell them it drifted from the original.

## the one-way doors, named

- **Copying a recipe in** — yours from that moment; drift from the original is silent by design.
- **Creating a collection** — cheap to make, expensive to retire: records accumulate, references
  point at it, and deleting it later is a migration, not an undo.
- **Installing anything** (`npm i`, `git_modules/`) for a domain module — recipes are copied, not
  installed; importing one re-creates the fork the copy-and-adapt split exists to avoid.

## common mistakes

| mistake | reality |
|---|---|
| building because you didn't find it in 30 seconds | there are four places to look, and the first is this workspace |
| searching only the literal word the operator used | the existing thing is usually filed under a synonym — search the concept, not the string |
| `npm i` / `git_modules` a recipe module | recipes are copied, not installed — importing re-creates the fork the split exists to avoid |
| copying a recipe in and keeping all of it | deleting what you won't use IS the adoption step |
| lifting from another workspace under `projects/` | those hold real personal data; read for reference only |
| proposing without naming the setup cost | the `.env` keys and the accounts are the actual price |
| installing or copying, then telling the operator | they decide what enters their workspace, before it enters |
| finding it, using it, and leaving the bad description in place | the next session will miss it exactly as you just did |
