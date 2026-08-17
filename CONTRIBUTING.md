# Contributing

Issues are very welcome — bug reports, questions, and "this was confusing" are all useful.

**For anything larger than a typo, please open a discussion or an issue before a pull request.**
This is a small codebase maintained by one person, and it's kinder to both of us to agree on the
shape before you spend an evening on it.

## The size budget is real

Core is deliberately, aggressively small. `npm run metrics` reports code lines, complexity, the
inherited surface and prose lines against committed budgets, and `npm run metrics:check` exits
non-zero when one is blown. A blown budget isn't a blocker — it's a prompt to answer three
questions in the pull request description:

1. **Does the ENGINE read it?** That's the whole test for a new core collection or field.
2. **Is this a recipe creeping into core?** Anything domain-shaped — people, meetings, products,
   content — belongs in a module, not here.
3. **Could a module do it instead?** Modules ship collections, skills, commands, agents and UI.

Two shapes get rejected on sight: an enum that is a roadmap (`adapter: gdrive|s3|git` with one
implementation), and a capability that needs a record seeded before it exists.

## Working on it

```bash
npm install
npm run verify               # layers + size budgets + tests — run this before a commit
```

`verify` is the gate CI runs. Its parts, when you want one of them alone:

```bash
npm run layers               # the record/workspace import direction
npm run metrics:check        # size budgets
npm test                     # tiers 1+2, ~7s, zero dependencies
npm test -- --unit           # tier 1 only: pure functions, no fs, no git
npm test -- --only=namespace # one file
npm test -- --clean          # discard the cached tier-2 fixture and rebuild it
```

**Tier 1** (`test/unit/`) is pure functions. **Tier 2** (`test/integration/`) drives the real
compiler, store and CLI binary against a workspace built by `dreamteamer init` — cached once and
copied per test, so the whole suite stays in the seconds range. A test is expected to arrive with the
change it covers.

Beyond the suite, it is still worth watching a change work end to end the way a stranger meets it:

```bash
cd "$(mktemp -d)" && git init -q && npm init -y
npm install /path/to/your/dreamteamer
npx dreamteamer init && npx dreamteamer compile && npx dreamteamer check
npx dreamteamer notes add --title "does it work"
```

If a change can't be demonstrated that way, that's usually a sign the change is in the wrong place.

## A release that changes behaviour gets an UPDATING.md section

[`UPDATING.md`](UPDATING.md) is one section per version, newest first, and it answers one question:
what does an operator have to DO. Most of the time that is `dt compile` and nothing else — say so
explicitly rather than leaving the section out, because an absent section reads as "nobody checked".

A section is required when a release changes an observable behaviour, adds a refusal that an existing
workspace can hit, or needs a module to declare something new. Write it in the same commit as the
change, while you still know which of your edits an operator can actually notice.

## Engine and UI are separate

`dreamteamer` is the engine; [dreamteamer-vscode](https://github.com/dreamteamer/dreamteamer-vscode)
is a surface over it. The rule: anything the extension can do must be doable from a CLI invocation
an agent can run headlessly. A new capability lands here as an engine function **and** a CLI verb;
only then does it get a button.

## Releasing

Publishing is **tag-triggered and CI-only** — no npm token exists on any laptop, and a merge to main
can never publish by itself. That is the permission gate, expressed as a workflow.

```bash
git checkout main && git pull
# bump "version" in package.json, then keep the lockfile in step:
npm install --package-lock-only
npm run verify                      # layers + budgets + tests
git commit -am "0.7.0" && git push
# the tag is what publishes, and it must MATCH package.json or release.yml fails first:
git tag -a v0.7.0 -m "0.7.0 — one line on what changed"
git push origin v0.7.0
```

Then watch the `release` workflow: it re-checks tag == version, runs the layer graph, the budgets, the
tests and a first-run smoke against the **packed tarball** (which is what catches a missing entry in
`files[]`), and only then `npm publish --provenance`.

⚠ **npm's unconditional unpublish window is 72 hours** and the VS Code Marketplace has none at all —
a version there can only be superseded. Add the [`UPDATING.md`](UPDATING.md) section before tagging,
not after.

The extension releases the same way from its own repo, and **the engine goes first**: the extension
tolerates an older engine, but a workspace using a namespace needs the engine published before the
extension is useful on it.

## Commits

Conventional-ish prefixes (`feat:`, `fix:`, `docs:`, `refactor:`) and a body explaining *why*.
The commit log is the design record for this project — please write for the person reading it in
six months.
