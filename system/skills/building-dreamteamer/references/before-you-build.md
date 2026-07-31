# before you build — look for it first

**Core principle:** when the workspace can't do something, **look before you build** — and when you do
find something, **propose concretely, never install or copy silently.** The operator decides what
enters their workspace.

This replaced a standalone `discovering-new-capabilities` skill on 2026-07-31, whose premise — "find
and propose an **installable** module" — had been reversed: domain modules are no longer packages you
install. The looking still matters; the taking changed shape.

## where to look, in order

| # | look at | what you get |
|---|---|---|
| 1 | **this workspace's own modules** — `.dreamteamer/manifest.yaml` names them | the thing may already exist under a name you didn't guess. Check the collections list and `dt <c> --help` before anything else |
| 2 | **the `recipes` repo** — reference modules maintained to be **copied and adapted** | a working module with its reasoning attached. Read its `using-recipes` skill for the adoption procedure |
| 3 | **a sibling workspace under `projects/`** | another vault may already have solved it concretely. That is a *reference*, not a source — and it holds real personal data, so read, never lift |
| 4 | **the engine's own surface** — `dt help`, plus the purpose-built verbs `help` omits | a verb missing from `help` is not a verb that doesn't exist |

Only after all four: build it, in the module that owns the concept.

## how to propose

Say three things: **what you found**, **what adopting it would cost**, and **what you would delete
from it**. That last one is not politeness — adoption is mostly deletion, and a proposal that skips it
is asking the operator to accept a maximal module sight unseen. Name the `.env` keys, external
accounts and binaries it needs, because a skill whose setup nobody did is a skill that fails at the
worst possible moment.

Then stop and let them choose. Copying a recipe in is a one-way door in practice: from that moment the
copy is theirs to maintain, and nothing will later tell them it drifted from the original.

## common mistakes

| mistake | reality |
|---|---|
| building because you didn't find it in 30 seconds | there are four places to look, and the first is this workspace |
| `npm i` / `git_modules` a recipe module | recipes are copied, not installed — importing re-creates the fork the split exists to avoid |
| copying a recipe in and keeping all of it | deleting what you won't use IS the adoption step |
| lifting from another workspace under `projects/` | those hold real personal data; read for reference only |
| proposing without naming the setup cost | the `.env` keys and the accounts are the actual price |
| installing or copying, then telling the operator | they decide what enters their workspace, before it enters |
