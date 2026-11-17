# DreamTeamer First Principles

DreamTeamer First Principles is an experiment: the smallest typed engine we could write that still makes a [dreamteamer](https://github.com/dreamteamer/dreamteamer) workspace work. It reads published DreamTeamer modules as they are, validates and writes typed records as plain files, and compiles the workspace's schema into instructions an AI agent can read — in about 850 lines of TypeScript with one runtime dependency.

> **This is not a release.** It is a core slice on the `experiment/first-principles-ts` branch. It is not published to npm and it does not replace dreamteamer 0.49. Every capability on this page carries a status — **Verified**, **Partial**, **Planned** or **Open**, defined under [Status](#status) — and [GAP.md](GAP.md) lists, with evidence, where the code falls short of what this page describes, and which of those gaps have been closed.

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
| Read records | **Verified** | `list` and `get` see every data record of a real workspace — 4,837 of them — and return the same stored values as the released engine |
| Write records | **Partial** | `add`, `set` and `rm` give a record the file name, id, timestamp and layout the released engine gives it, and validate before anything reaches disk. The reverse side of a reference is not maintained |
| Enforce what a descriptor says | **Partial** | Types, allowed values, patterns, required fields, references, real dates, formats and bounds. Not the contents of objects and maps, uniqueness or cross-field rules |
| Check a whole workspace | **Partial** | The same verdict as the released engine on a real workspace: no errors. It runs none of the checks that modules add |
| Take values from the command line | **Verified** | A value is converted by the declared type of its field, so text is stored as typed |
| Compile instructions | **Partial** | One generic `AGENTS.md` and the model as JSON, in a folder that nothing loads automatically |
| Run published modules unchanged | **Partial** | Their collections, mixins and skills are read. Their commands, agents, views, navigation and extensions are not |
| Never run git | **Verified** | No verb runs git, and nothing commits by itself |
| Stay inside the record you name | **Verified** | A reference or an id cannot name anything but a record of its collection. A descriptor or a symbolic link can still place a collection elsewhere |
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

There is no npm package. Clone the branch and install its dependencies — `yaml` at run time; TypeScript and a handful of published modules for the tests:

```bash
git clone --branch experiment/first-principles-ts --single-branch <repository> dreamteamer-first-principles
cd dreamteamer-first-principles
npm install
npm test             # 33 tests
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

From an empty folder to a validated workspace with two published modules and one collection of your own. Every command below was run as written, in this order; the output is what it printed, with absolute paths shortened to `…`. The date in the ids is the day you run it.

**1. Create the workspace and install modules.** A workspace is a folder whose `package.json` lists at least one DreamTeamer module; its modules are its npm dependencies.

```bash
cd ..                                  # out of the engine checkout
mkdir my-workspace && cd my-workspace
git init
npm init -y
echo node_modules > .gitignore
npm install --save-exact @dreamteamer/tasks@0.3.4 @dreamteamer/users@0.3.0
```

Name every module you want, including the ones another module depends on. `@dreamteamer/tasks` needs `@dreamteamer/users`, and npm fetches it either way, but only the modules listed in the workspace's own `package.json` are read. The released engine reads them the same way; its `install` verb is what adds the dependencies for you, and this version has no such verb. If you leave one out, `check` names it and gives the npm command.

**2. See what the engine resolved.**

```bash
dtx modules
dtx collections
dtx check
```
```
@dreamteamer/tasks@0.3.4 [npm] — not acted on here: engine
@dreamteamer/users@0.3.0 [npm] — not acted on here: engine
tasks (@dreamteamer/tasks) — 25 fields
teams (@dreamteamer/users) — 12 fields
users (@dreamteamer/users) — 23 fields
0 records · 3 collections · 2 modules · 0 errors · 0 warnings
```

`modules` also names the parts of each module's manifest that this version sees and does not act on — here the engine version each module asks for. Fields such as `tasks.project` point at collections from modules you did not install. Those modules are declared as optional peers, so the fields stay in the model, and a value in one is simply not resolved.

**3. Add records and read them back.**

```bash
dtx add users --name "Dana Oren"
dtx add tasks "Buy milk" --assignee dana-oren --due 2026-12-01
```
```
✔ users/dana-oren · …/my-workspace/data/users/dana-oren.user.md
✔ tasks/2026-11-17--buy-milk · …/my-workspace/data/tasks/2026-11-17--buy-milk.task.md
```

One bare argument is the record's title. The engine made each id from the collection's own rule, completed `dana-oren` to the reference `users/dana-oren`, stamped `created`, filled in the defaults, and wrote one plain file — the same file the released engine writes for the same command:

```bash
cat data/tasks/*--buy-milk.task.md
```
```
---
name: Buy milk
assignee: users/dana-oren
due: '2026-12-01'
created: '2026-11-17T04:32:16+02:00'
status: suggested
urgent: false
confidence: normal
---
```

```bash
dtx list tasks                                       # 2026-11-17--buy-milk
dtx list tasks --filter assignee=users/dana-oren     # the same one: what is assigned to Dana
dtx get task/2026-11-17--buy-milk                    # the fields as JSON; --json wraps them with the ref, id and path
```

**4. Change a record, and watch a bad write get refused.**

```bash
dtx set tasks/2026-11-17--buy-milk status=doing tags=home,errand
dtx add tasks "Call the bank" --assignee nobody
dtx add tasks "Call the bank" --due 2026-13-45
dtx add tasks "Call the bank" --priority 1
```
```
✔ tasks/2026-11-17--buy-milk · …/my-workspace/data/tasks/2026-11-17--buy-milk.task.md
✖ tasks/2026-11-17--call-the-bank rejected — nothing written
  tasks/2026-11-17--call-the-bank: assignee: broken reference users/nobody
✖ tasks/2026-11-17--call-the-bank rejected — nothing written
  tasks/2026-11-17--call-the-bank: due: expected a real date, YYYY-MM-DD
✖ tasks has no field priority — its fields are slug, name, description, status, project, assignee, …
```

A refused command exits with status 1 and leaves the disk as it was: `ls data/tasks` still shows one file. The `set` changed the `status` line, added `tags`, and touched nothing else in the file.

**5. Add a collection of your own, and extend one you installed.** Your own sources live in a module under `modules/` — a folder whose `package.json` has a `dreamteamer` key.

```bash
mkdir -p modules/home/collections
cat > modules/home/package.json <<'EOT'
{ "name": "home", "version": "0.0.1", "dreamteamer": {} }
EOT
cat > modules/home/collections/recipes.collection.yaml <<'EOT'
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
EOT
cat > modules/home/collections/tasks.collection.yaml <<'EOT'
name: tasks
overlay: true
fields:
  recipe: { type: recipes, description: The dish this errand is for. }
EOT
```

The first descriptor is a new collection. The second is an *overlay*: it adds a field to `tasks` without touching the installed package. Neither needs a compile step before you use it:

```bash
dtx add recipes "Shakshuka" --cook dana-oren --course main --steps "# Method

Simmer the sauce, crack in the eggs, cover for five minutes."
dtx set tasks/2026-11-17--buy-milk recipe=shakshuka
dtx set recipes/shakshuka serves=lots
```
```
✔ recipes/shakshuka · …/my-workspace/data/recipes/shakshuka.recipe.md
✔ tasks/2026-11-17--buy-milk · …/my-workspace/data/tasks/2026-11-17--buy-milk.task.md
✖ recipes/shakshuka rejected — nothing written
  recipes/shakshuka: serves: expected an integer
```

**6. Check the whole workspace, and try to delete something that is in use.** `check` reads every record, validates it the way a write does, reports any file in a collection's folder that it does not recognise, changes nothing, and exits 1 if it finds an error.

```bash
dtx check                                       # 3 records · 4 collections · 3 modules · 0 errors · 0 warnings
dtx rm recipes/shakshuka
```
```
✖ recipes/shakshuka is referenced by 1 record(s) — nothing removed; fix them, or pass --force:
  tasks/2026-11-17--buy-milk
```
```bash
dtx set tasks/2026-11-17--buy-milk recipe=      # an empty value clears a field
dtx rm recipes/shakshuka                        # ✔ removed recipes/shakshuka
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

`.dt/AGENTS.md` says how to run this engine, then lists every collection — what it is, when to use it, where its records live, how its ids are made, and every field with its type, allowed values and default — followed by the skills the installed modules ship and where to read each. `.dt/model.json` is the whole resolved model, for tools. Nothing loads these files for you yet: point your agent at `.dt/AGENTS.md` yourself. The folder ignores itself in git and can be deleted at any time, because no command reads it.

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

Run `compile` and read `.dt/AGENTS.md`: it gives the command to run and, for each collection, the fields you can set. Then:

- Write with `add` and `set`, not by editing files, and run `check` after any hand edit.
- Type a value as it is. Text is stored as text whatever it contains; a list is given by repeating the flag or separating values with commas; a reference to one collection can be given as the bare id.
- `rm` refuses a record that others point at. Fix the records it lists; `--force` is for when breaking them is what you mean.
- `list` takes `--filter field=value`, more than once, and `--json`. It has no sort.

#### Trying it on a workspace you already have

```bash
dtx modules -w /path/to/workspace
dtx check   -w /path/to/workspace
```

`modules`, `collections`, `list`, `get` and `check` write nothing, and what they read agrees with the released engine: on a real workspace, the same stored value in every frontmatter field of the records compared, and the same verdict from `check`. `compile` writes only `.dt/`.

`add`, `set` and `rm` change records in the workspace you name, so try them on a copy first. The released engine reads what this version writes, and lists it under the same id, with these exceptions:

- A write that sets a reference does not update the reverse side on the record it points at, and the released engine's `check` then reports that field as stale until `relations rebuild` is run.
- A record that passes here only because this version checks less — a broken cross-field rule, a duplicate where a field must be unique — is rejected by the released engine's `check`.

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
| Contracts | `src/types.ts` | 86 | The types every other part shares: `Module`, `Collection`, `Field`, `Model`, `DtRecord`, `Issue` |
| Discovery | `src/discover.ts` | 60 | Which modules does this workspace have? |
| Model | `src/model.ts` | 132 | Merge every module's collections, mixins and overlays into one resolved model |
| Store | `src/store.ts` | 357 | Read, validate and change records |
| Compile | `src/compile.ts` | 57 | Project the model into files for agents and tools |
| API | `src/api.ts` | 6 | The one surface adapters import |
| CLI | `src/cli.ts`, `bin/dt.ts` | 147 | Read the command line, convert each value by the type of its field, and print |

### The workspace and its modules

A **workspace** is a folder whose `package.json` lists at least one module, or which has one under `modules/`. Any other folder is refused with a message. Everything the engine knows comes from a few places, and each has one owner:

| Path | What it is | Who writes it |
|---|---|---|
| `package.json` | Which modules the workspace uses — its npm dependencies | you, through npm |
| `node_modules/<module>/` | Installed modules: **read-only inputs**. The engine never writes here and never runs code from here | npm |
| `modules/<name>/` | Your own modules: the collections, mixins and skills that belong to this workspace | you |
| `data/…` | Your records, one file each, at the path each collection's descriptor names | `add`, `set`, `rm` — or you by hand, followed by `check` |
| `dreamteamer-exports.json` | Ids that live in another repository and are vouched for; references to them are accepted | read-only here |
| `.dt/` | What `compile` wrote. Derived and disposable | `compile` only |

A **module** is an npm package, or a folder under `modules/`, whose `package.json` carries a `dreamteamer` key. From a module this version reads:

- `collections/**/*.collection.yaml` — collection descriptors and overlays
- `mixins/**/*.mixin.yaml` — partial descriptors that a collection lists under `mixins`
- `skills/**/SKILL.md` — indexed by name and description
- from the manifest: `title`, `namespaces`, `dependencies` and `peer_collections`

It sees, and reports through `dtx modules`, the manifest keys `extension`, `nav`, `setup`, `preset`, `env`, `engine`, `ignore` and `vars`, and acts on none of them. It does not read commands, agents, command bindings, UI views or navigation documents, and it runs nothing an extension contributes (**Partial**). Across the 21 published packages we ran against, that is 67 collection descriptors, 2 mixins and 21 skills read; 30 commands, 43 command bindings, 27 UI views, 3 agents, 2 navigation documents and 5 extensions not.

How modules are found (**Verified**, and the same rule as the released engine):

- The modules are the names under `dependencies` and `devDependencies` in the workspace's `package.json` whose installed package has the `dreamteamer` key, followed by every such folder under `modules/`. Each group is taken in alphabetical order.
- A dependency that is listed but missing from `node_modules/` is an error. So is a module whose `dreamteamer.dependencies` names a module the workspace does not list; the message says whether it is merely unlisted, and how to list it.
- A package that arrived only as another package's dependency is not a module of this workspace until you list it yourself. The same goes for the members of a preset package such as `@dreamteamer/core`: nothing installs them for you.

What is not carried over from the released engine (**Partial**):

- Of the workspace's own `dreamteamer` settings only `disable` is read, and it skips a dependency whose package name it lists. This is not the released engine's list, which names `modules/<id>` or `<kind>/<id>`; an entry written for one engine does nothing in the other.
- The released engine's other arrangements are not read: another workspace's records as a layer, modules delivered as git clones, sources at the workspace root, and a `data_path` other than `data`. `check` warns when it finds the last two of those settings.
- It does not enforce the rules the released engine applies when it compiles a module: declared namespaces, references only to collections a module owns or declares, a closed set of manifest keys. A module that breaks them loads here and fails to compile there.

### Schema compilation: the resolved model

"Compiling the schema" is two separate things in this version.

**Resolution** happens in memory, on every command, straight from the sources. There is no cache and nothing to keep fresh: edit a descriptor and the next command sees it. On a workspace with 22 modules and 54 collections, a command that only resolves the model takes about 0.13 seconds, Node's start-up included, and `check` over 4,837 records about one second — about what the released engine takes. A cache was part of the plan; with these numbers it has no job yet (**Open**).

**`compile`** writes a projection of the resolved model to disk, for readers that are not this engine. Nothing in the engine reads it back. It is described [below](#compile).

This differs from the released engine, where commands read the compiled runtime and a changed source has no effect until the next compile.

How the model is resolved:

1. **Mixins** are loaded by name.
2. **Collections.** A descriptor's `name` is the collection's name, namespace included (`rnd/design-docs`). The mixins it lists are merged first, then the descriptor itself on top. Without other instructions, records live under `data/<name>` as Markdown and ids come from `{{ name | slug }}`. Two modules declaring the same collection is an error, and the first keeps the name.
3. **Overlays.** A descriptor with `overlay: true` adds fields to a collection that another module owns. An overlay of a collection that is not installed is skipped without comment — that is how a module extends an optional peer. An overlay that redefines an existing field wins, with a warning.
4. **Types.** A field's type is a scalar, an installed collection, or a collection that some module lists under `peer_collections`. A declared peer that is not installed keeps its field: a value there must name that collection and is otherwise not resolved, and `check` says how many such references there are. Anything else — a misspelt type, a collection nobody declares — is an error.
5. **Skills** are indexed and the exports manifest is read.

The result is one `Model` value: the modules, the collections with their fields, the skills, the vouched-for ids, and every issue found on the way. `check` prints the issues. An error among them stops `add`, `set` and `compile`, which print it too.

**Field types.** `string`, `markdown`, `url`, `email`, `date`, `datetime`, `integer`, `number`, `boolean`, `object`, `map`, `position`, `reference` (a record of any collection), a collection name (a record of that collection), or a list of collection names (a record of any of them). `many: true` makes the field a list. `required`, `default`, `enum`, `pattern`, `minimum`, `maximum`, `minLength`, `maxLength`, `soft`, `body` (the field that is the Markdown text of the file) and `mirror_of` have the effects described under [Records and data operations](#records-and-data-operations). Any other key on a field is carried in the model and has no effect.

Status. Resolution of the published schema is **Verified**: on 54 collections it agrees with the released engine's compiled descriptors on every key of all 940 fields, and on where and how each collection is stored. Three things are **Partial**:

- What it keeps of a collection is the name, description, use-when text, storage, id rule and fields. Display metadata, record titles, constraints and every other descriptor key are dropped.
- A descriptor is checked for a name, known mixins, a known storage format and a known type on every field; a key it does not know is a warning. The manifest of a module is trusted as written. Validating both where they enter is **Planned**.
- Where two modules shape the same collection, a few outcomes differ from the released engine: the order of fields, which of a local and an npm overlay wins, and how a mixin's storage and id rule combine with the collection's own. Field order already differs in 6 of the 54 published collections; none is affected by the other differences today.

### Records and data operations

A record is one file, `<storage.path>/<id>.<suffix>.<format>`. The suffix is the collection's `storage.suffix`, or else its name in the singular, by the released engine's rules: `tasks` gives `task`, `companies` gives `company`, `rnd/user-stories` gives `user-story`. The id is the file's path inside the collection's folder, so an id may contain slashes. A reference to a record is always `<collection>/<id>`; on the command line the collection may be given in the singular (`task/…`).

A Markdown record carries its fields as YAML frontmatter and one field — the one its descriptor marks `body: true` — as the text below. YAML and JSON records are the whole file. A folder-shaped record (`storage.shape: folder`) is a folder holding an entry file. All four behave as in the released engine for `add`, `get`, `set` and `list` (**Verified**). Binary storage is refused, and `check` says it has not checked such a collection. Records kept inside their owner's folder (`storage.under`) are not supported.

| Verb | What it does |
|---|---|
| `list <collection>` | Prints the ids of the collection, sorted. `--filter field=value` keeps the records whose field equals, or whose list holds, that value; give it more than once to narrow further. `--json` prints the records. There is no sort |
| `get <ref>` | Prints the record's fields as JSON. `--json` wraps them as `data`, beside the record's `ref`, `collection`, `id`, `path` and `mtimeMs` |
| `add <collection> ["title"] --field value…` | Stamps `created`, applies the defaults, makes the id, validates, writes. Refuses to replace an existing record |
| `set <ref> field=value…` | Reads the record, applies the changes, validates, and rewrites only the lines of the fields it changed. An empty value clears a field, or puts back its default if it has one |
| `rm <ref>` | Deletes the record. It refuses when other records reference it, or when a folder-shaped record holds other records inside its folder; `--force` deletes anyway |
| `check` | Validates every record, reports files it does not recognise, changes nothing, and exits 1 on any error |

**Ids** (**Verified** against ids the released engine produced). `add` uses `--id` when you give one. Otherwise it takes the first template in the collection's `ids.from` whose fields are all present. The filters are `slug`, `date` with an optional format such as `date:YYYY/MM` or `date:HH-mm`, `basename` and `pad`. A date is read from the value as written, in its own zone; `created` is local time with its offset. A name with accents loses them (`zoe-bronte-angstrom`); a name with no Latin letters or digits becomes a hash, and the engine says so. An id, given or generated, is a relative path with no empty, `.` or `..` segment and no leading slash.

**Validation** runs before anything is written by `add` and `set`, and across the whole workspace in `check`:

- the id matches the collection's id pattern;
- every required field is present;
- there are no unknown fields (`created` is always allowed, and must be a date and time);
- each value has its field's type, is one of its `enum` values, matches its `pattern` and lies within its bounds;
- a `date` is a real date, a `datetime` has a zone, a `url` has a scheme, an `email` looks like one;
- a list appears only where the field is `many`;
- every reference names an existing record of an allowed collection, an id that the exports manifest vouches for, or a declared peer that is not installed; a `soft` reference need not exist.

It is as lenient as the released engine about how a value is written in a file: a quoted number or boolean, and a one-item list where one value is expected, are accepted.

Status. That an invalid write is refused before disk is **Verified**: by test, by the walkthrough, and by a side-by-side run of 73 invalid writes in which no refusal, by either engine, wrote anything. What is checked is **Partial**:

- Not enforced: the contents of an `object` or a `map`, uniqueness, and a collection's cross-field `constraints`.
- Generated reverse fields (`mirror_of`) are neither produced nor checked (**Planned**). After a write here that sets a reference whose other side is such a field, the released engine's `check` then reports that field as stale.
- `check` covers less than the released `check` does: it runs none of the checks that module extensions add.

**The write protocol.** A write validates first, and a rejected write changes nothing. An accepted write goes to a temporary file beside the target, which then replaces the target in one rename — but only if the target is still as it was when this command read it. (**Partial**.) What that gives, measured before the latest changes, which did not touch this mechanism:

- A record is never left half-written: 60 kills during writes left no malformed record. A killed write can leave a `.tmp` file beside the record; `check` reports it, and the next write to that record removes it once it is a minute old.
- Under contention most conflicting writes are refused and can be retried, and a few report success and are lost: of 30 simultaneous `set` commands on one record, roughly three in ten are refused and about one in twenty of the rest is lost. The released engine loses most of them.
- The check that makes this work compares modification times. It leaves two short windows in which such a change is still overwritten, and it has no test.

**Staying inside the record you name** (**Verified**). `get`, `add`, `set` and `rm` refuse a reference or an id that is empty, has a `.` or `..` segment, or starts with a slash, and a path that would leave the workspace. An id must match a file under exactly that spelling, so a file system that ignores case cannot turn one id into another, and a symbolic link below a collection's folder is neither listed nor followed. What remains is deliberate trust in a module: a descriptor decides where its collection is stored. A storage path outside the workspace is not read or written, and `check` says so; a collection folder that is itself a symbolic link is followed, as it is by the released engine.

**What a rewrite does to a file.** `set` replaces the lines of the keys it changes, drops the lines of a key it clears, and appends a new key at the end of the frontmatter. Every other character stays as it was written: comments, quoting, folded strings, the body (**Verified**). Comments and blank lines between keys stay where they are; a comment on the same line as a changed key goes with it. If the edited text would not read back as exactly the fields intended — a record that uses YAML anchors, say — the frontmatter is written afresh instead. `add` writes the same file the released engine writes for the same command, except that a string which needs quoting gets double quotes where the released engine uses single ones.

### Compile

`compile` is explicit and optional. It writes exactly three files, all inside `<workspace>/.dt/`:

| File | For | Content |
|---|---|---|
| `AGENTS.md` | an agent | how to run this engine; every collection — its description, when to use it, where its records live, how its ids are made, and each field with its type, allowed values and default; every skill with its description and its path |
| `model.json` | tools and UIs | the entire resolved model, with paths relative to the workspace |
| `.gitignore` | git | `*`, so the folder never appears in `git status` |

It never touches git, the workspace's `package.json`, its root `.gitignore`, or anything else outside `.dt/`, and it writes nothing when the model has an error (**Verified**). `model.json` is the same wherever the workspace is checked out; `AGENTS.md` names the engine's own path on this machine. Since nothing reads the output, a stale `.dt/` cannot make a command wrong; only an agent reading an old `AGENTS.md` can be behind. Run `compile` again after you change modules or descriptors. Nothing tells you it is stale.

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

Everything the CLI does goes through `src/api.ts`; the CLI adds only the reading of the command line and the printing. A script uses the same surface (**Verified**, from a checkout):

```ts
import { buildModel, add, list, check } from '/path/to/dreamteamer-first-principles/src/api.ts';

const model = buildModel('/path/to/my-workspace');
const record = add(model, 'users', { name: 'Sam Diaz' });
console.log(record.ref, list(model, 'users', { kind: 'human' }).map((r) => r.id));
console.log(check(model).issues.filter((i) => i.severity === 'error'));
```

It exports `buildModel`, `discover`, `findCollection`, `splitRef`, `listIds`, `list`, `get`, `add`, `set`, `rm`, `referrers`, `check`, `validate`, `stamp`, `compile`, `instructions`, the `DtError` class and the types in `src/types.ts`. A refused call throws a `DtError` whose `issues` array says why. Values passed here are taken as they are; converting text by a field's type belongs to the CLI.

The package cannot be installed from npm or from a tarball yet: Node refuses to run TypeScript from inside `node_modules`, and there is no build step (**Planned**).

## Command reference

```
dtx <verb> [target] [arguments] [-w <workspace>]
```

| Verb | Example |
|---|---|
| `modules` | `dtx modules` |
| `collections` | `dtx collections` |
| `list <collection>` | `dtx list tasks --filter status=todo --json` |
| `get <ref>` | `dtx get users/dana-oren --json` |
| `add <collection>` | `dtx add tasks "Buy milk" --due 2026-12-01 --tags home,errand --urgent` |
| `set <ref>` | `dtx set tasks/2026-11-17--buy-milk status=done due=` |
| `rm <ref>` | `dtx rm tasks/2026-11-17--buy-milk` |
| `check` | `dtx check` |
| `compile` | `dtx compile` |
| `help`, `--version` | `dtx help` |

- The verb comes first. `-w <path>` or `--workspace <path>` names the workspace to act on; the default is the current directory.
- A field is given as `--<field> <value>`, `--<field>=<value>`, or `<field>=<value>`. On `add`, one bare argument after the collection is the record's title.
- A value is converted by the declared type of its field. Text is stored as typed. A plain decimal number or `true`/`false` becomes one where the field is numeric or boolean; a boolean flag with no value means true. A date and time typed without seconds or without a zone (`2026-12-01 10:00`) is completed with this machine's zone on that day. A list takes a repeated flag, or one value with commas. A field that points at one collection takes a bare id. An `object` or a `map` is written as YAML or JSON.
- A flag or a field the verb does not know is refused, with the ones it does know.
- `--id <id>` on `add` uses that id instead of generating one. `--force` on `rm` deletes a record that others reference. `--json` on `get` and `list` prints records with their `ref`, `collection`, `id`, `path` and `mtimeMs`, and their fields under `data`.
- A collection may be named in the singular wherever one is named, a reference included: `dtx get task/2026-11-17--buy-milk`.
- Exit status: 0 on success, 1 when a command is refused or fails, 2 for an unknown verb. A failure is one line; set `DT_DEBUG=1` to see a stack trace for one the engine did not expect.

Known limits:

- A value that begins with `--` must be given as `--<field>=<value>`.
- A value in a list field cannot contain a comma.
- `list` has no sort, and `--filter` tests equality only.

## Key concepts and design philosophy

This version keeps DreamTeamer's principles and adds a few of its own. Unlike the list in the released README, not every box is ticked: each line says where this version stands today.

- **What this version adds**
  - **One workspace owns the data** — modules are read-only inputs delivered by npm, and every write lands in the one workspace a command names. *Verified for references and ids. A descriptor still decides where its collection is stored.*
  - **Typed contracts** — the parts of the engine talk through the types in `src/types.ts`, checked by `tsc` in strict mode. *Partial: types do not validate what arrives from disk. Records are validated at run time, and so are a descriptor's types and storage format; a module's manifest is trusted.*
  - **One interface for every adapter** — the CLI, and later harness output and a UI, call the same `src/api.ts`, so the rules for records live in one place. *Verified for the one adapter that exists.*
  - **Derived state is disposable** — everything the engine generates is in `.dt/`, ignored by git, and can be deleted without losing anything. *Verified.*
  - **No hidden steps** — no compile is needed before a command sees a change, nothing commits by itself, and no module code runs. *Verified.*
  - **Small enough to read** — 845 lines and one runtime dependency. A cache, a service, a database or a generator needs a demonstrated job before it is added. *Verified, by counting.*
- **Core engine design goals**
  - **AI native** — *Partial.* An agent gets the schema and one validated way to write, as a file it has to be pointed at.
  - **Lean core** — *Verified.*
  - **Adaptive and extensible** — *Partial.* Your own collections and overlays work. The extension contract is Open.
  - **Standards-first** — *Partial.* Markdown, YAML frontmatter and Git, as in the released engine. Validation is about seventy lines of TypeScript, not JSON Schema; whether to adopt a schema library is Open.
  - **Friendly for both agents and humans** — *Verified.* Data and instructions are plain text, and a mistake gets one line that says what to do.
  - **Harness-agnostic** — *Planned.* There is one generic instruction file today.
- **Context engineering principles**
  - **Schema-first** — *Partial.* The schema is compiled for agents and not yet delivered to them.
  - **Relational** — *Partial.* References to one collection, to several, or to any are validated on every write, and a delete will not break them. The generated reverse side of a relation is Planned.
  - **Schema-validated** — *Partial.* Every write is validated, and so is the workspace with `check`, which covers less than the released `check` does.
  - **Rich metadata** — *Partial.* Descriptions, use-when guidance and every field reach the agent. Display metadata is dropped.
  - **Modular** — *Verified.*
  - **Layered schemas** — *Verified.* An overlay adds or redefines the fields of an installed collection.
  - **Layered data** — *Open.* A module that ships records is not handled.
  - **Persistent and durable** — *Verified.* All state is plain files in the workspace.
  - **Non-destructive data authoring**, **Auditable**, **Versioned** — through Git, which you run yourself. A change to one field is a change to its lines only. `commit` is Planned. Pinning a module is `npm install --save-exact`; the engine does not check versions (Open).
- **Developer experience**
  - **CLI driven** — *Partial.* Nine verbs, against thirty-three in the released engine.
  - **Programmable** — *Verified* from a checkout; not installable as a package.
  - **AI primitives** — *Partial.* Skills are indexed. Commands and agents are not read.
  - **Extensible** — *Open.*
  - **Portable** — *Verified* for records and for `model.json`, which are the same on every machine. `AGENTS.md` names the engine's path on this one.
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
| Records it can see | 4,837 of 5,039: every record stored under `data/`. What it does not see are the 202 records of the eight system collections (skills, collections, commands and so on), which are not stored as record files |
| Values it reads | The same as the released engine in every frontmatter field of the 4,705 records compared; the body, byte for byte, in the 240 compared |
| Records that validate | All 4,837: no errors and no warnings, the released engine's verdict too |
| Records it can create | Ids and file names match the released engine's for the cases tried, among them a meeting in its year and month folder and a release keyed by its product |
| A record written here, read by the released engine | Read, listed under the same id, and accepted — unless the write set a reference with a reverse side, which the released `check` then reports stale, or broke a rule this version does not enforce |
| Source kinds read | Collections, mixins, skills. Not commands, agents, command bindings, UI views, navigation or extensions |
| Speed | `check` about one second, as the released engine; `list`, `get`, `add` and `compile` were a quarter to two-thirds faster when measured |

[GAP.md](GAP.md) has the table per module and the evidence.

### Security considerations

[Standard AI agent security measures](https://code.claude.com/docs/en/security) apply here as they do to the released engine: this version is meant to add no capability to an agent, only a governed way to do what it could already do. Never give an agent credentials, tokens or keys, and treat a private workspace as private.

Specific to this version:

- **It executes no module code.** It reads YAML, JSON and Markdown from a module's folder and nothing else; it never imports a module's extension and never runs its scripts or its setup. That is safer, and it is also why extensions do nothing here.
- **A module is still trusted input.** Its descriptors decide where records are read, written and deleted, and supply the patterns that values are matched against. Vet a module before you install it, as you would any other code you run.
- **A reference is not a path.** A reference or an id that is empty or contains `.` or `..` is refused by every verb, so one taken from an agent or another program cannot reach a file other than a record of the collection it names.

## Development

```bash
npm test             # node --test, 33 tests in three suites, a few seconds
npm run typecheck    # tsc, strict, emits nothing
```

The source is TypeScript that Node runs directly, so it uses only syntax that can be erased — no enums, no parameter properties — and imports carry their `.ts` extension. There is no build output and no CI.

`test/engine.test.ts` drives the API on a throw-away workspace of invented modules. `test/cli.test.ts` runs the command line as a process. `test/published.test.ts` runs the engine on real published modules — tasks, users, companies, contacts, assets, meetings, rnd and the released engine's system module — which are development dependencies of this repository, pinned to exact versions. Together they execute 99% of the lines and 86% of the branches of `src/` and `bin/`.

This is a deliberately small codebase. Before adding to it, check that the addition has a demonstrated job.

## License

[Apache-2.0](LICENSE), the licence of the repository this branch belongs to.
