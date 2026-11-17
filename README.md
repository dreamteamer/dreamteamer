# DreamTeamer First Principles

DreamTeamer First Principles is an experiment: the smallest typed engine we could write that still makes a [dreamteamer](https://github.com/dreamteamer/dreamteamer) workspace work. It reads published DreamTeamer modules as they are, validates and writes typed records as plain files, and compiles the workspace's schema into instructions an AI agent can read — in about 500 lines of TypeScript with one runtime dependency.

> **This is not a release.** It is a core slice on the `experiment/first-principles-ts` branch. It is not published to npm and it does not replace dreamteamer 0.49. Every capability on this page carries a status — **Verified**, **Partial**, **Planned** or **Open**, defined under [Status](#status) — and [GAP.md](GAP.md) lists, with evidence, where the code falls short of what this page describes. Read its short version before you point this at a workspace you care about: several of the gaps can lose data.

#### What is DreamTeamer, and what is this version for?

DreamTeamer is a context package manager. It keeps an agentic workspace **modular, structured and consistent** by treating context as source code. A workspace is a Git repository of typed records — tasks, contacts, design documents — stored as plain Markdown and YAML, beside the schema that says what each record is. Because the schema reaches every agent conversation, an agent asked to "create a task to buy milk" runs one validated command instead of guessing what a task is, what it looks like and where it goes. Schemas, skills and commands ship in modules that are installed with npm.

The released engine does this in about 18,500 lines of JavaScript. This version starts from an empty branch and asks a narrower question: **what is the essential engine?** Which responsibilities must exist, which contracts connect them, and how much of the published module family runs on top of them unchanged. It is a redesign from the user journeys, not a translation of the existing code. Its size is therefore a finding to scrutinise rather than a goal, and what the missing lines were buying is recorded in [GAP.md](GAP.md).

## Status

| Label | Meaning |
|---|---|
| **Verified** | Implemented, and exercised by an automated test in this repository or by a recorded run against real published modules. |
| **Partial** | Implemented, with limits or known wrong behaviour. [GAP.md](GAP.md) has the detail. |
| **Planned** | Part of what this version is meant to do. Nothing in the code yet. |
| **Open** | Not decided. The design question is still open, so there is nothing to build yet. |

Where things stand, in one screen:

| Capability | Status | In short |
|---|---|---|
| Find the workspace's modules | **Verified** | The npm dependencies named in the workspace's `package.json`, plus its `modules/` folder — the same rule, and the same 22 modules, as the released engine on a real workspace |
| Resolve the published schema | **Verified** | 54 collections and 940 fields resolve field for field as in the released engine. Display metadata and the rest of a descriptor are dropped |
| Read records | **Verified** | `list` and `get` return the same stored values as the released engine for every record this version can see |
| Write records | **Partial** | `add`, `set` and `rm`, with every write validated before it reaches disk. File names are wrong for some plurals, several id rules are not understood, and the reverse side of a reference is not maintained |
| Enforce what a descriptor says | **Partial** | Types, allowed values, patterns, required fields and references are enforced. Formats, bounds and cross-field rules are not |
| Check a whole workspace | **Partial** | In a real workspace it sees 4,705 of the 5,038 records the released engine sees |
| Take values from the command line | **Partial** | Values are parsed as YAML, so some ordinary text is refused, and some is silently changed |
| Compile instructions | **Partial** | One generic `AGENTS.md` and the model as JSON, in a folder that nothing loads automatically |
| Run published modules unchanged | **Partial** | Their collections, mixins and skills are read. Their commands, agents, views, navigation and extensions are not |
| Never run git | **Verified** | No verb runs git, and nothing commits by itself |
| Stay inside the record you name | **Partial** | In ordinary use only `data/` and `.dt/` are written. A reference or an id containing `..` breaks that: `add` and `set` then write anywhere inside the workspace, installed packages included, and `get` and `rm` reach outside it |
| Use it from a script | **Verified** | `src/api.ts`, from a checkout |
| Deliver instructions to each agent harness | **Planned** | |
| `commit`, an installable package, a UI over the model | **Planned** | |
| `init`, `install` and `status`; extensions; upgrades and migrations; live refresh | **Open** | |

## Getting started

### For humans (non coders)

There is no conversational setup in this version. The released README lets you paste one prompt into your agent and have a workspace built for you; that relies on `init`, on guided module setup and on instructions installed into the agent harness, none of which exist here. If that is what you need, use the [released engine](https://github.com/dreamteamer/dreamteamer).

### For agents (and code-savvy humans)

#### Prerequisites

```bash
node -v        # 23.6 or later is what package.json declares: Node runs the TypeScript directly, there is no build step
npm -v         # the npm that ships with it
git --version  # optional for the engine, which never runs git; a workspace is meant to be a git repository
```

It has been run on Node 25.4 and 22.23, on macOS only.

The command blocks on this page carry `#` comments. bash ignores them; an interactive zsh does not, unless you first run `setopt interactivecomments`.

#### Installation

There is no npm package. Clone the branch and install its dependencies — `yaml` at run time, `typescript` and `@types/node` for development:

```bash
git clone --branch experiment/first-principles-ts --single-branch <repository> dreamteamer-first-principles
cd dreamteamer-first-principles
npm install
npm test             # 5 tests
npm run typecheck    # tsc, strict, emits nothing
```

`<repository>` is any clone of the engine repository that has the branch; at the time of writing the branch has not been pushed to GitHub.

The CLI is `bin/dt.ts`. Nothing puts it on your `PATH`, and a workspace that also has the released engine already owns the names `dt` and `dreamteamer`, so this page calls it `dtx`:

```bash
export DTX_HOME="$PWD"                         # the checkout you just made
dtx() { node "$DTX_HOME/bin/dt.ts" "$@"; }
dtx                                            # prints the verb list
```

An agent whose shell does not keep functions between calls runs `node <checkout>/bin/dt.ts <verb> …` instead.

#### Walkthrough

From an empty folder to a validated workspace with two published modules and one collection of your own. Every command below was run as written, in this order; the output is what it printed, with absolute paths shortened to `…`. The date in the ids is the UTC day on which you run it.

**1. Create the workspace and install modules.** A workspace is a folder with a `package.json`; its modules are its npm dependencies.

```bash
cd ..                                  # out of the engine checkout
mkdir my-workspace && cd my-workspace
git init
npm init -y
echo node_modules > .gitignore
npm install --save-exact @dreamteamer/tasks@0.3.4 @dreamteamer/users@0.3.0
```

Name every module you want, including the ones another module depends on. `@dreamteamer/tasks` needs `@dreamteamer/users`, and npm fetches it either way, but only the modules listed in the workspace's own `package.json` are read. The released engine reads them the same way; its `install` verb is what adds the dependencies for you, and this version has no such verb.

**2. See what the engine resolved.**

```bash
dtx modules
dtx collections
```
```
@dreamteamer/tasks@0.3.4 [npm] — not implemented here: peer_collections
@dreamteamer/users@0.3.0 [npm] — not implemented here: peer_collections
tasks (@dreamteamer/tasks) — 20 fields
teams (@dreamteamer/users) — 11 fields
users (@dreamteamer/users) — 20 fields
```

`modules` also names some of the parts of each module's manifest that this version sees and does not act on. Run `dtx check` now and it prints nine warnings and no errors: fields such as `tasks.project` point at collections from modules you did not install, so they are left out of the model. That is an optional peer being absent, not a fault.

**3. Add records and read them back.**

```bash
dtx add users --name "Dana Oren"
dtx add tasks --name "Buy milk" --assignee users/dana-oren --due 2026-12-01
```
```
✔ users/dana-oren · …/my-workspace/data/users/dana-oren.user.md
✔ tasks/2026-11-17--buy-milk · …/my-workspace/data/tasks/2026-11-17--buy-milk.task.md
```

The engine made each id from the collection's own rule, filled in the defaults, stamped `created`, and wrote one plain file:

```bash
cat data/tasks/*--buy-milk.task.md
```
```
---
created: 2026-11-17T01:22:42.896Z
status: suggested
urgent: false
confidence: normal
name: Buy milk
assignee: users/dana-oren
due: 2026-12-01
---
```

```bash
dtx list tasks                          # 2026-11-17--buy-milk
dtx get tasks/2026-11-17--buy-milk      # the fields as JSON; --json wraps them with the ref, id and path
```

**4. Change a record, and watch a bad write get refused.**

```bash
dtx set tasks/2026-11-17--buy-milk status=doing tags=home tags=errand
dtx add tasks --name "Call the bank" --assignee users/nobody
dtx add tasks --name "Call the bank" --status maybe --priority 1
```
```
✔ tasks/2026-11-17--buy-milk · …/my-workspace/data/tasks/2026-11-17--buy-milk.task.md
✖ tasks/2026-11-17--call-the-bank rejected — nothing written
  tasks/2026-11-17--call-the-bank: assignee: broken reference users/nobody
✖ tasks/2026-11-17--call-the-bank rejected — nothing written
  tasks/2026-11-17--call-the-bank: status: not one of suggested | todo | doing | blocked | done | closed
  tasks/2026-11-17--call-the-bank: priority: unknown field
```

A rejected write exits with status 1 and leaves the disk as it was: `ls data/tasks` still shows one file.

**5. Add a collection of your own, and extend one you installed.** Your own sources live in a module under `modules/` — a folder whose `package.json` has a `dreamteamer` key.

```bash
mkdir -p modules/home/collections
cat > modules/home/package.json <<'EOF'
{ "name": "home", "version": "0.0.1", "dreamteamer": {} }
EOF
cat > modules/home/collections/recipes.collection.yaml <<'EOF'
name: recipes
description: A dish this household cooks, and who cooks it best.
storage: { path: data/recipes, format: md }
ids: { from: '{{ name | slug }}', pattern: '^[a-z0-9-]+$' }
fields:
  name: { type: string, required: true }
  cook: { type: users }
  serves: { type: integer, default: 2 }
  course: { type: string, enum: [starter, main, dessert] }
  steps: { type: markdown, body: true }
EOF
cat > modules/home/collections/tasks.collection.yaml <<'EOF'
name: tasks
overlay: true
fields:
  recipe: { type: recipes, description: The dish this errand is for. }
EOF
```

The first descriptor is a new collection. The second is an *overlay*: it adds a field to `tasks` without touching the installed package. Neither needs a compile step before you use it:

```bash
dtx add recipes --name "Shakshuka" --cook users/dana-oren --course main \
  --steps "Simmer the sauce, crack in the eggs, cover for five minutes."
dtx set tasks/2026-11-17--buy-milk recipe=recipes/shakshuka
dtx set recipes/shakshuka serves=lots
```
```
✔ recipes/shakshuka · …/my-workspace/data/recipes/shakshuka.recipe.md
✔ tasks/2026-11-17--buy-milk · …/my-workspace/data/tasks/2026-11-17--buy-milk.task.md
✖ recipes/shakshuka rejected — nothing written
  recipes/shakshuka: serves: expected an integer
```

**6. Check the whole workspace.** `check` reads every record it recognises, validates it the way a write does, changes nothing, and exits 1 if it finds an error.

```bash
dtx check          # … 3 records · 4 collections · 3 modules · 0 errors · 9 warnings
```

It is also how you find what a delete leaves behind, because `rm` does not look for records that point at the one it removes:

```bash
dtx rm recipes/shakshuka
dtx check          # ✖ tasks/2026-11-17--buy-milk: recipe: broken reference recipes/shakshuka
dtx set tasks/2026-11-17--buy-milk recipe=      # an empty value clears a field
dtx check          # 0 errors again
```

**7. Compile instructions for an agent.**

```bash
dtx compile
```
```
✔ …/my-workspace/.dt/model.json
✔ …/my-workspace/.dt/AGENTS.md
✔ …/my-workspace/.dt/.gitignore
```

`.dt/AGENTS.md` lists every collection — what it is, when to use it, where its records live, which fields are required — followed by the skills the installed modules ship. `.dt/model.json` is the whole resolved model, for tools. Nothing loads these files for you yet: point your agent at `.dt/AGENTS.md` yourself. The file tells the agent to run `dt`; tell it to run `node <checkout>/bin/dt.ts`. The folder ignores itself in git and can be deleted at any time, because no command reads it.

**8. Commit.** The engine never runs git; what you wrote is ordinary files.

```bash
git status --short
git add .gitignore package.json package-lock.json modules data
git commit -m "A workspace with tasks, users and recipes"
```
```
?? .gitignore
?? data/
?? modules/
?? package-lock.json
?? package.json
```

#### If you are an agent

Run `compile` and read `.dt/AGENTS.md`. Where it says `dt`, run `node <checkout>/bin/dt.ts`. It names each collection's required fields only, so before your first write to a collection read its entry under `collections` in `.dt/model.json`: that is the resolved descriptor, with every overlay merged in. Then:

- Write with `add` and `set`, not by editing files, and run `check` after any hand edit.
- Quote every text value twice: `--name '"Re: budget"'`. Unquoted, a value is read as YAML, and a number, `true`, `null`, or text with a colon, a bracket, a quote, `@`, `*` or `#` in it is refused, crashes, or is silently cut short. Inside the quotes write a line break as `\n`, a quote as `\"` and a backslash as `\\`. The [command reference](#command-reference) says why.
- Never build a reference or an `--id` from text you did not check. One that contains `..`, or is empty, can read, rewrite or delete files other than the record you meant, outside the workspace included.
- `list` has no filter. A flag such as `--filter` is ignored and every id is printed.

#### Trying it on a workspace you already have

```bash
dtx modules -w /path/to/workspace
dtx check   -w /path/to/workspace
```

`modules`, `collections`, `list`, `get` and `check` write nothing, and what they read agrees with the released engine: on a real workspace, the same stored value in every frontmatter field of 4,705 records. `compile` writes only `.dt/`.

`add`, `set` and `rm` change records in the workspace you name, so try them on a copy first. The released engine reads what this version writes, with these exceptions:

- A record that passes here only because this version checks less — an impossible date, a broken cross-field rule, an `updated` field — is rejected by the released engine's `check`.
- A write that sets a reference does not update the reverse side on the record it points at, and the released engine's `check` then reports that field as stale until `relations rebuild` is run.
- Records of `companies` and `rnd/user-stories` get a file name the released engine does not recognise, and the ones it wrote are invisible here.
- A `set` rewrites the whole frontmatter in this version's own style, and drops any comments in it.

### For VS Code users

The [dreamteamer VS Code extension](https://marketplace.visualstudio.com/items?itemName=dreamteamer.dreamteamer-vscode) works with the released engine. Nothing in this version feeds it (**Open**).

## Under the hood

Warning: technical details ahead.

This version keeps the released engine's central idea — a well-defined data model for the workspace, handed to every agent together with one validated way to change it — and rebuilds it as a handful of small parts behind one interface.

```
package.json ──┐                          ┌──► store ◄──► data/    your records
node_modules/ ─┼─► discover ─► model ─────┤
modules/ ──────┘                          └──► compile ──► .dt/    derived, disposable

                     adapters call the model, the store and compile through src/api.ts
                     (today: the CLI; harness files and a UI are not built)
```

| Part | File | Lines | Responsibility |
|---|---|---|---|
| Contracts | `src/types.ts` | 78 | The types every other part shares: `Module`, `Collection`, `Field`, `Model`, `DtRecord`, `Issue` |
| Discovery | `src/discover.ts` | 46 | Which modules does this workspace have? |
| Model | `src/model.ts` | 100 | Merge every module's collections, mixins and overlays into one resolved model |
| Store | `src/store.ts` | 174 | Read, validate and change records |
| Compile | `src/compile.ts` | 30 | Project the model into files for agents and tools |
| API | `src/api.ts` | 6 | The one surface adapters import |
| CLI | `src/cli.ts`, `bin/dt.ts` | 56 | Parse arguments and print. Its one rule of its own is how a value is read: as YAML |

### The workspace and its modules

A **workspace** is a folder with a `package.json`. Everything the engine knows comes from a few places, and each has one owner:

| Path | What it is | Who writes it |
|---|---|---|
| `package.json` | Which modules the workspace uses — its npm dependencies | you, through npm |
| `node_modules/<module>/` | Installed modules: **read-only inputs**. The engine never runs code from here, and in ordinary use never writes here; a reference or an id containing `..` can ([GAP.md](GAP.md), F3) | npm |
| `modules/<name>/` | Your own modules: the collections, mixins and skills that belong to this workspace | you |
| `data/…` | Your records, one file each, at the path each collection's descriptor names | `add`, `set`, `rm` — or you by hand, followed by `check` |
| `dreamteamer-exports.json` | Ids that live in another repository and are vouched for; references to them are accepted | read-only here |
| `.dt/` | What `compile` wrote. Derived and disposable | `compile` only |

A **module** is an npm package, or a folder under `modules/`, whose `package.json` carries a `dreamteamer` key. From a module this version reads:

- `collections/**/*.collection.yaml` — collection descriptors and overlays
- `mixins/**/*.mixin.yaml` — partial descriptors that a collection lists under `mixins`
- `skills/**/SKILL.md` — indexed by name and description
- from the manifest: `title`, `namespaces`, `dependencies`

It sees, and reports through `dtx modules`, the manifest keys `extension`, `nav`, `setup`, `peer_collections`, `ignore` and `vars`, and acts on none of them. It does not notice `preset`, `env` or `engine`. It does not read commands, agents, command bindings, UI views or navigation documents, and it runs nothing an extension contributes (**Partial**). Across the 21 published packages we ran against, that is 67 collection descriptors, 2 mixins and 21 skills read; 30 commands, 43 command bindings, 27 UI views, 3 agents, 2 navigation documents and 5 extensions not.

How modules are found (**Verified**, and the same rule as the released engine):

- The modules are the names under `dependencies` and `devDependencies` in the workspace's `package.json` whose installed package has the `dreamteamer` key, followed by every such folder under `modules/`. Each group is taken in alphabetical order.
- A dependency that is listed but missing from `node_modules/` is an error. So is a module whose `dreamteamer.dependencies` names a module the workspace does not list.
- A package that arrived only as another package's dependency is not a module of this workspace until you list it yourself. The same goes for the members of a preset package such as `@dreamteamer/core`: nothing installs them for you.

What is not carried over from the released engine (**Partial**):

- Of the workspace's own `dreamteamer` settings only `disable` is read, and it skips a dependency whose package name it lists. This is not the released engine's list, which names `modules/<id>` or `<kind>/<id>`; an entry written for one engine does nothing in the other.
- The released engine's other arrangements are not read: another workspace's records as a layer, modules delivered as git clones, sources at the workspace root, and a `data_path` other than `data`.
- It does not enforce the rules the released engine applies when it compiles a module: declared namespaces, references only to collections a module owns or declares, a closed set of manifest keys. A module that breaks them loads here and fails to compile there.

### Schema compilation: the resolved model

"Compiling the schema" is two separate things in this version.

**Resolution** happens in memory, on every command, straight from the sources. There is no cache and nothing to keep fresh: edit a descriptor and the next command sees it. On a workspace with 22 modules and 54 collections, a command that only resolves the model takes about 0.13 seconds, Node's start-up included, and `check` over 4,705 records about 0.9 seconds — as fast as the released engine or faster on every verb we timed. A cache was part of the plan; with these numbers it has no job yet (**Open**).

**`compile`** writes a projection of the resolved model to disk, for readers that are not this engine. Nothing in the engine reads it back. It is described [below](#compile).

This differs from the released engine, where commands read the compiled runtime and a changed source has no effect until the next compile.

How the model is resolved:

1. **Mixins** are loaded by name.
2. **Collections.** A descriptor's `name` is the collection's name, namespace included (`rnd/design-docs`). The mixins it lists are merged first, then the descriptor itself on top. Without other instructions, records live under `data/<name>` as Markdown and ids come from `{{ name | slug }}`. Two modules declaring the same collection is an error, and the first keeps the name.
3. **Overlays.** A descriptor with `overlay: true` adds fields to a collection that another module owns. An overlay of a collection that is not installed is skipped without comment — that is how a module extends an optional peer. An overlay that redefines an existing field wins, with a warning.
4. **Optional peers.** A field whose type names a collection that is not installed is left out of the model, with a warning. A field that may point at several collections is narrowed to the installed ones. A record that already holds a value in such a field then fails `check` and cannot be edited until the field is removed or the peer installed; the released engine keeps the field and warns.
5. **Skills** are indexed and the exports manifest is read.

The result is one `Model` value: the modules, the collections with their fields, the skills, the vouched-for ids, and every issue found on the way. `check` prints those issues; the other verbs do not. `compile` writes its files, and `add` writes records, even when the model has errors.

**Field types.** `string`, `markdown`, `url`, `email`, `date`, `datetime`, `integer`, `number`, `boolean`, `object`, `map`, `reference` (a record of any collection), a collection name (a record of that collection), or a list of collection names (a record of any of them). `many: true` makes the field a list. `required`, `default`, `enum`, `pattern`, `body` (the field that is the Markdown text of the file) and `mirror_of` have the effects described under [Records and data operations](#records-and-data-operations). Any other key on a field is carried in the model and has no effect.

Status. Resolution of the published schema is **Verified**: on 54 collections it agrees with the released engine's compiled descriptors on every key of all 940 fields, and on where and how each collection is stored. Three things are **Partial**:

- What it keeps of a collection is the name, description, use-when text, storage, id rule and fields. Display metadata, record titles, constraints and every other descriptor key are dropped.
- A descriptor is checked for a name, for known mixins and for a type on every field, and otherwise trusted as written. An unknown key is accepted. A misspelt type is taken for an absent collection, and the field is dropped with a warning. Validating descriptors and manifests where they enter is **Planned**.
- Where two modules shape the same collection, a few outcomes differ from the released engine: the order of fields, which of a local and an npm overlay wins, and how a mixin's storage and id rule combine with the collection's own. Field order already differs in 6 of the 54 published collections; none is affected by the other differences today.

### Records and data operations

A record is one file, `<storage.path>/<id>.<suffix>.<format>`. The suffix is the collection's `storage.suffix`, or else its name with a final `s` removed: a task is `data/tasks/2026-11-17--buy-milk.task.md`. That rule is wrong for other plurals — `companies` becomes `companie` where the released engine writes `company` — so the two engines do not see each other's records in such a collection (**Partial**). The id is the file's path inside the collection's folder, so an id may contain slashes. A reference to a record is always `<collection>/<id>`.

A Markdown record carries its fields as YAML frontmatter and one field — the one its descriptor marks `body: true` — as the text below. YAML and JSON records are the whole file. A folder-shaped record (`storage.shape: folder`) is a folder holding an entry file. All four behave as in the released engine for `add`, `get`, `set` and `list` (**Verified** by side-by-side runs). Binary storage is refused, and `check` skips such collections without saying so. Records kept inside their owner's folder (`storage.under`) are not supported.

| Verb | What it does |
|---|---|
| `list <collection>` | Prints the ids of the collection, sorted. It takes no filter, sort or format, and a flag it does not know, such as `--filter`, is ignored without a word |
| `get <ref>` | Prints the record's fields as JSON. `--json` wraps them as `data`, beside the record's `ref`, `collection`, `id`, `path` and `mtimeMs` |
| `add <collection> --field value…` | Applies the defaults, stamps `created`, makes the id, validates, writes. Refuses to replace an existing record |
| `set <ref> field=value…` | Reads the record, applies the changes, validates, and replaces the file. An empty value clears a field; a default is not put back |
| `rm <ref>` | Deletes the record. `rm` does not look for records that point at the one it removes; `check` finds them afterwards. For a folder-shaped record it deletes the whole folder, whatever else is in it |
| `check` | Validates every record it recognises, changes nothing, and exits 1 on any error |

**Ids.** `add` uses `--id` when you give one. Otherwise it takes the first template in the collection's `ids.from` whose fields are all present. Two filters exist: `date`, the first ten characters of a timestamp, and `slug`, which keeps lower-case ASCII letters, digits and hyphens. For plain names the ids are the same as the released engine's. The rest is **Partial**:

- Published modules also use `basename` and formatted dates such as `date:YYYY/MM`, which are not understood. `add meetings` fails for that reason, and eleven other published collections have such a rule; an explicit `--id` works.
- The date in an id is the UTC day, not the local one, because `created` is stamped in UTC.
- An accented name comes out differently (`zoe-bronte-a-ngstro-m` for "Zoë Brontë-Ångström"), and a name with no Latin letters becomes a ten-character hash, silently. The released engine produces a different hash, and says so.
- An explicit `--id` is checked only against the collection's id pattern, if it has one. Where there is none, an id containing `..` is written wherever it points inside the workspace.

**Validation** runs before anything is written by `add` and `set`, and across the whole workspace in `check`:

- the id matches the collection's id pattern;
- every required field is present and not empty;
- there are no unknown fields (`created` and `updated` are always allowed, and neither is validated);
- each value has its field's type, is one of its `enum` values and matches its `pattern`;
- a list appears only where the field is `many`;
- every reference names an existing record of an allowed collection, or an id that the exports manifest vouches for.

Status. That an invalid write is refused before disk is **Verified**: by test, by the walkthrough, and by a side-by-side run of 73 invalid writes in which no refusal, by either engine, wrote anything. What is checked is **Partial**:

- A `date` is checked for its shape only, and a `datetime` for whether JavaScript can parse it, so `2026-13-45` and `March 5` pass.
- Not enforced: the format of a `url` or an `email`, the contents of an `object` or a `map`, numeric bounds and lengths, uniqueness, soft references, and a collection's cross-field `constraints`.
- In a few cases it is stricter than the released engine: a quoted number or boolean, a one-item list in a single-value field, and a required field holding `null` are refused here and accepted there.
- `check` reads the files whose names it recognises; any other file in a collection's folder is passed over in silence.
- Generated reverse fields (`mirror_of`) are neither produced nor checked (**Planned**). After a write here that sets a reference whose other side is such a field, the released engine's `check` then reports that field as stale.

**The write protocol.** A write validates first, and a rejected write changes nothing. An accepted write goes to a temporary file beside the target, which then replaces the target in one rename — but only if the target is still as it was when this command read it. (**Partial**.) What that gives, measured:

- A record is never left half-written: 60 kills during writes left no malformed record. A write that is killed part-way leaves a `.tmp` file beside the record, which nothing cleans up.
- Under contention most conflicting writes are refused and can be retried, and a few report success and are lost: of 30 simultaneous `set` commands on one record, roughly three in ten are refused and about one in twenty of the rest is lost. The released engine loses most of them.
- The check that makes this work compares modification times. It leaves two short windows in which such a change is still overwritten, and it has no test.

**Staying inside the workspace.** `add` and `set` refuse a path that leaves the workspace root. Inside the root they follow `..` wherever it leads: `set` with such a reference rewrites any matching file in the workspace, in `node_modules/` and `.git/` too. That is a comparison of paths as text; it does not follow symbolic links, and neither does the released engine. `get` and `rm` make no such check: a reference with `..` in it reads or deletes a matching file outside the workspace. An empty id or `..` is not refused. (**Partial** — these are defects, and [GAP.md](GAP.md) shows each one.)

**What a rewrite does to a file.** `set` re-serialises the whole frontmatter in the engine's own YAML style. The values survive. Comments in the frontmatter do not, and quoting and folding change, so the diff of a one-field change may touch other lines. The two engines write the same record differently in any case: the order of keys, the form of `created`, and whether a body ends with a newline (**Partial**). In a Markdown collection that has no `body: true` field, text below the frontmatter is not read, and a `set` removes it; the released engine does the same.

### Compile

`compile` is explicit and optional. It writes exactly three files, all inside `<workspace>/.dt/`:

| File | For | Content |
|---|---|---|
| `AGENTS.md` | an agent | every collection — its description, when to use it, where its records live, which fields are required — and every skill with its description |
| `model.json` | tools and UIs | the entire resolved model |
| `.gitignore` | git | `*`, so the folder never appears in `git status` |

It never touches git, the workspace's `package.json`, its root `.gitignore`, or anything else outside `.dt/` (**Verified**). Since nothing reads the output, a stale `.dt/` cannot make a command wrong; only an agent reading an old `AGENTS.md` can be behind. Run `compile` again after you change modules or descriptors. Nothing tells you it is stale.

What `compile` is meant to become (**Planned**): one projection per agent harness, written where that harness loads it and with the module's skills, commands and agents installed beside it, as the released engine does for Claude Code, Codex, Cursor, Gemini CLI and Pi. Today there is one generic file that no harness picks up on its own.

### Commits and Git

**This engine never runs git** (**Verified**). `add`, `set` and `rm` change files and stop; `compile` writes only ignored files. A workspace is still meant to be a Git repository — the log is the audit trail and the undo — but staging and committing are yours:

```bash
git add data/tasks/2026-11-17--buy-milk.task.md
git commit -m "Buy milk is in progress"
```

This is a deliberate difference from the released engine, in which record writes do not commit but schema changes commit themselves. Here nothing commits by itself, ever.

**Planned:** `commit <ref>…`, one explicit verb that stages exactly the records you name and commits them, so that publishing stays scoped to what a session wrote. **Open:** whether the history, diff and revert of a record become verbs or stay plain git.

### Programmatic API

Everything the CLI does goes through `src/api.ts`; the CLI adds only argument parsing and printing. A script uses the same surface (**Verified**, from a checkout):

```ts
import { buildModel, add, listIds, check } from '/path/to/dreamteamer-first-principles/src/api.ts';

const model = buildModel('/path/to/my-workspace');
const record = add(model, 'users', { name: 'Sam Diaz' });
console.log(record.ref, listIds(model, 'users'));
console.log(check(model).issues.filter((i) => i.severity === 'error'));
```

It exports `buildModel`, `discover`, `splitRef`, `listIds`, `get`, `add`, `set`, `rm`, `check`, `validate`, `compile`, `instructions`, the `DtError` class and the types in `src/types.ts`. A rejected write throws a `DtError` whose `issues` array says why. Values passed here are taken as they are; the YAML parsing described below belongs to the CLI. The path checks do not: `get` and `rm` take any reference they are given.

The package cannot be installed from npm or from a tarball yet: Node refuses to run TypeScript from inside `node_modules`, and there is no build step (**Planned**).

## Command reference

```
dtx <verb> [target] [--field value …] [field=value …] [-w <workspace>] [--id <id>] [--json]
```

| Verb | Example |
|---|---|
| `modules` | `dtx modules` |
| `collections` | `dtx collections` |
| `list <collection>` | `dtx list tasks` |
| `get <ref>` | `dtx get users/dana-oren --json` |
| `add <collection>` | `dtx add tasks --name "Buy milk" --due 2026-12-01` |
| `set <ref>` | `dtx set tasks/2026-11-17--buy-milk status=done` |
| `rm <ref>` | `dtx rm tasks/2026-11-17--buy-milk` |
| `check` | `dtx check` |
| `compile` | `dtx compile` |

- `-w <path>` or `--workspace <path>` names the workspace to act on. The default is the current directory.
- A field is given as `--<field> <value>`, or as `<field>=<value>` after the target. A hyphen in a flag name becomes an underscore. Repeat a field to build a list.
- `--id <id>` on `add` uses that id instead of generating one.
- `--json` on `get` prints an object with the record's `ref`, `collection`, `id`, `path` and `mtimeMs`, and its fields under `data`.
- A collection may be named in the singular for `list` and `add` (`dtx add task --name "Water the plants"`), where dropping its final `s` gives the right word. A reference is always spelled in full.
- Exit status: 0 on success, 1 when a command is refused or fails, 2 for an unknown verb.

Known limits (**Partial**; each is shown in [GAP.md](GAP.md)):

- **A value is read as YAML.** That is what makes `--urgent true` a boolean and `--serves 4` a number. Text that looks like YAML is not treated as text. Some of it is refused with a message that does not say why: `--name "Re: budget"` is a map, `--name 2026` a number. Some of it crashes: `--name "[draft] plan"`. Some of it is changed without a word. A `#` that starts a value, or follows a space inside it, begins a comment: `--name "Fix issue #42"` stores `Fix issue`, and `set <ref> 'steps=# Method'` erases the field and reports success. The words `null` and `~` do the same. A line break inside a value becomes a space. The safe habit is to wrap every text value in a second pair of quotes — `--name '"Re: budget"'` — and inside them to write a line break as `\n`, a quote as `\"` and a backslash as `\\`.
- One value given to a list field is stored as a single value, not as a one-item list, and a comma-separated value is not split.
- A flag always takes the next word as its value. `--name=value` and a flag with no value are not understood. A flag placed before the verb swallows it: `dtx --strict check` prints the verb list and exits 0, having checked nothing.
- `set` with nothing to change still reports success.
- A missing reference for `get`, `set` or `rm`, or a record that cannot be parsed, ends in a stack trace instead of a message. Run outside a workspace, every verb does. A missing collection for `list` or `add` gives `unknown collection undefined`.
- There is no `help` verb and no `--version`. Run `dtx` with no arguments, inside a workspace, for the verb list.

## Key concepts and design philosophy

This version keeps DreamTeamer's principles and adds a few of its own. Unlike the list in the released README, not every box is ticked: each line says where this version stands today.

- **What this version adds**
  - **One workspace owns the data** — modules are read-only inputs delivered by npm, and every write is meant to land in the one workspace a command names. *Partial: in ordinary use nothing outside `data/` and `.dt/` is written. A reference or an id containing `..` breaks that.*
  - **Typed contracts** — the parts of the engine talk through the types in `src/types.ts`, checked by `tsc` in strict mode. *Partial: types do not validate what arrives from disk. Records are validated at run time; descriptors and manifests are trusted.*
  - **One interface for every adapter** — the CLI, and later harness output and a UI, call the same `src/api.ts`, so the rules for records live in one place. *Verified for the one adapter that exists; how the CLI reads a value is the exception.*
  - **Derived state is disposable** — everything the engine generates is in `.dt/`, ignored by git, and can be deleted without losing anything. *Verified for what `compile` generates. A write that is killed can leave a `.tmp` file in `data/`.*
  - **No hidden steps** — no compile is needed before a command sees a change, nothing commits by itself, and no module code runs. *Verified.*
  - **Small enough to read** — 490 lines and one runtime dependency. A cache, a service, a database or a generator needs a demonstrated job before it is added. *Verified, by counting.*
- **Core engine design goals**
  - **AI native** — *Partial.* An agent gets the schema and one validated way to write, as a file it has to be pointed at.
  - **Lean core** — *Verified.*
  - **Adaptive and extensible** — *Partial.* Your own collections and overlays work. The extension contract is Open.
  - **Standards-first** — *Partial.* Markdown, YAML frontmatter and Git, as in the released engine. Validation is about forty lines of TypeScript, not JSON Schema; whether to adopt a schema library is Open.
  - **Friendly for both agents and humans** — *Verified.* Data and instructions are plain text.
  - **Harness-agnostic** — *Planned.* There is one generic instruction file today.
- **Context engineering principles**
  - **Schema-first** — *Partial.* The schema is compiled for agents and not yet delivered to them.
  - **Relational** — *Partial.* References to one collection, to several, or to any are validated on every write. The generated reverse side of a relation is Planned.
  - **Schema-validated** — *Partial.* Every write is validated, and so is the workspace with `check`, which covers less than the released `check` does.
  - **Rich metadata** — *Partial.* Descriptions and use-when guidance reach the agent. Display metadata is dropped.
  - **Modular** — *Verified.*
  - **Layered schemas** — *Verified.* An overlay adds or redefines the fields of an installed collection.
  - **Layered data** — *Open.* A module that ships records is not handled.
  - **Persistent and durable** — *Verified.* All state is plain files in the workspace.
  - **Non-destructive data authoring**, **Auditable**, **Versioned** — through Git, which you run yourself. `commit` is Planned. Pinning a module is `npm install --save-exact`; the engine does not check versions (Open).
- **Developer experience**
  - **CLI driven** — *Partial.* Nine verbs, against thirty-three in the released engine.
  - **Programmable** — *Verified* from a checkout; not installable as a package.
  - **AI primitives** — *Partial.* Skills are indexed. Commands and agents are not read.
  - **Extensible** — *Open.*
  - **Portable** — *Partial.* A workspace is still plain files in Git. `.dt/model.json` holds absolute paths, so it is not the same on two machines.
- **User experience**
  - **Conversational** — *Planned.*
  - **Presentational** — *Planned*, with no design yet: there is no UI, and the display metadata it would draw from is not carried.
  - **Collaborative** — through Git, which you run yourself.

## Compatibility with published modules

The aim is that the published `@dreamteamer/*` modules need no change. This is where that stands, measured on a private workspace that installs 21 published packages — 20 `@dreamteamer/*` modules and the released engine's own system module — and one local module, and holds about five thousand records:

| Measure | Result |
|---|---|
| Modules found | 22 of 22 |
| Collections resolved | 54 of 54, with all 940 fields agreeing with the released engine key for key |
| Records it can see | 4,705 of 5,038. It misses the 131 records of `rnd/user-stories`, whose files end in `.user-story.md` where this version looks for `.user-storie.md`, and the 202 records of the eight system collections (skills, collections, commands and so on), which are not stored as record files |
| Values it reads | The same as the released engine in every frontmatter field of the 4,705; the body, byte for byte, in the 240 compared |
| Records that validate | 4,694 of the 4,705 it sees. The other 11 hold references to the user stories it cannot see |
| Records it can create | Not in most of the 12 collections whose id rule it does not understand, unless you pass `--id` |
| A record written here, read by the released engine | Read. Accepted, with two exceptions: a write that set a reference with a reverse side leaves that side stale for the released `check`, and a record that passes here only because this version checks less is rejected there |
| Source kinds read | Collections, mixins, skills. Not commands, agents, command bindings, UI views, navigation or extensions |
| Speed | `check` 0.88 s against 0.92 s; `list`, `get`, `add` and `compile` a quarter to two-thirds faster |

[GAP.md](GAP.md) has the table per module and the evidence.

### Security considerations

[Standard AI agent security measures](https://code.claude.com/docs/en/security) apply here as they do to the released engine: this version is meant to add no capability to an agent, only a governed way to do what it could already do. Never give an agent credentials, tokens or keys, and treat a private workspace as private.

Specific to this version:

- **It executes no module code.** It reads YAML, JSON and Markdown from a module's folder and nothing else; it never imports a module's extension and never runs its scripts or its setup. That is safer, and it is also why extensions do nothing here.
- **A module is still trusted input.** Its descriptors decide where records are read, written and deleted, and supply the patterns that values are matched against. Vet a module before you install it, as you would any other code you run.
- **Do not pass on a reference or an id you did not write.** `get` and `rm` use a reference as a path: one that contains `..` reads or deletes outside the workspace, `set` rewrites a matching file anywhere inside it, and on a folder-shaped collection `rm` deletes a whole directory. Until that is fixed, this engine must not sit behind anything that accepts references from an agent, a web page or another program without checking them first.

## Development

```bash
npm test             # node --test, 5 tests, about a tenth of a second
npm run typecheck    # tsc, strict, emits nothing
```

The source is TypeScript that Node runs directly, so it uses only syntax that can be erased — no enums, no parameter properties — and imports carry their `.ts` extension. There is no build output and no CI.

The five tests build a throw-away workspace with one npm module and one local module. They cover discovery, mixins, overlays, optional peers, the add–get–set–rm round trip, rejected writes and compile, and they execute 98% of the lines and 64% of the branches of the six engine files. No test loads the CLI in `src/cli.ts`. The runs against real published modules described on this page were made by hand and are not part of the suite.

This is a deliberately small codebase. Before adding to it, check that the addition has a demonstrated job.

## License

Not settled for this branch. The released engine is Apache-2.0. This branch has no `LICENSE` file, and its `package.json` still carries the `ISC` that `npm init` writes by default.
