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

## Engine and UI are separate

`dreamteamer` is the engine; [dreamteamer-vscode](https://github.com/dreamteamer/dreamteamer-vscode)
is a surface over it. The rule: anything the extension can do must be doable from a CLI invocation
an agent can run headlessly. A new capability lands here as an engine function **and** a CLI verb;
only then does it get a button.

## Commits

Conventional-ish prefixes (`feat:`, `fix:`, `docs:`, `refactor:`) and a body explaining *why*.
The commit log is the design record for this project — please write for the person reading it in
six months.
