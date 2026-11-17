# DreamTeamer First Principles

A small, typed engine for [DreamTeamer](https://github.com/dreamteamer/dreamteamer) workspaces. It reads DreamTeamer modules installed with npm, keeps your records as plain Markdown and YAML files, validates every change before it reaches disk, and compiles the workspace's schema into instructions an AI agent can read.

#### What is a DreamTeamer workspace, and why would I want one?

A workspace is a Git repository of typed records — tasks, contacts, meetings, design documents — stored as plain files, beside the schema that says what each record is. Because an agent is given that schema, a request such as "create a task to buy milk" becomes one validated command instead of a guess about what a task is, what it looks like and where it goes. That is what keeps an agent consistent from one session to the next.

Schemas, skills and commands come in **modules**, installed with npm. You can use the [published modules](https://github.com/dreamteamer/dreamteamer-modules), extend them, or write your own in a few lines of YAML.

This engine does that job in a codebase small enough to read in a sitting: TypeScript that Node runs directly, one runtime dependency, no build step, no compile step between editing a schema and using it.

## Getting started

### Prerequisites

```bash
node -v        # 23.6 or later: Node runs the TypeScript directly
npm -v         # the npm that ships with it
git --version  # a workspace is meant to be a git repository
```

The command blocks on this page carry `#` comments. bash ignores them; an interactive zsh does not, unless you first run `setopt interactivecomments`.

### Installation

The engine is installed from a clone:

```bash
git clone <repository> dreamteamer-first-principles
cd dreamteamer-first-principles
npm install
npm test
```

The command line is `bin/dt.ts`. This page calls it `dtx`:

```bash
export DTX_HOME="$PWD"
dtx() { node "$DTX_HOME/bin/dt.ts" "$@"; }
dtx                                            # prints the verb list
```

Where a shell does not keep functions between calls, run `node <checkout>/bin/dt.ts <verb> …` instead.

### A workspace in ten minutes

**1. Create the workspace and install modules.** A workspace is a folder whose `package.json` lists at least one DreamTeamer module.

```bash
cd ..                                  # out of the engine checkout
mkdir my-workspace && cd my-workspace
git init
npm init -y
echo node_modules > .gitignore
npm install --save-exact @dreamteamer/tasks@0.3.4 @dreamteamer/users@0.3.0
```

List every module you want, including the ones another module depends on: `@dreamteamer/tasks` needs `@dreamteamer/users`. If you leave one out, `dtx check` names it and gives the npm command.

**2. See what you have.**

```bash
dtx modules
dtx collections
dtx check
```
```
dreamteamer@0.49.1 [engine]
@dreamteamer/tasks@0.3.4 [npm] — not acted on here: engine
@dreamteamer/users@0.3.0 [npm] — not acted on here: engine
agents (dreamteamer) — 6 fields
collections (dreamteamer) — 14 fields
…
repos (dreamteamer) — 7 fields
…
tasks (@dreamteamer/tasks) — 25 fields
teams (@dreamteamer/users) — 12 fields
users (@dreamteamer/users) — 23 fields
0 records · 12 collections · 3 modules · 0 errors · 0 warnings
```

The first module, `dreamteamer`, is the engine's own: the system collections every workspace has (see [Modules](#modules)).

**3. Add records and read them back.**

```bash
dtx add users --name "Dana Oren"
dtx add tasks "Buy milk" --assignee dana-oren --due 2026-12-01
```
```
✔ users/dana-oren · …/my-workspace/data/users/dana-oren.user.md
✔ tasks/2026-11-17--buy-milk · …/my-workspace/data/tasks/2026-11-17--buy-milk.task.md
```

One bare argument is the record's title. The engine made each id from the collection's own rule, completed `dana-oren` to the reference `users/dana-oren`, stamped `created`, filled in the defaults, and wrote one plain file:

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
dtx list tasks --filter assignee=users/dana-oren     # what is assigned to Dana
dtx get task/2026-11-17--buy-milk                    # the fields, as JSON
```

**4. Change a record, and watch a bad write get refused.**

```bash
dtx set tasks/2026-11-17--buy-milk status=doing tags=home,errand
dtx add tasks "Call the bank" --assignee nobody
dtx add tasks "Call the bank" --due 2026-13-45
```
```
✔ tasks/2026-11-17--buy-milk · …/my-workspace/data/tasks/2026-11-17--buy-milk.task.md
✖ tasks/2026-11-17--call-the-bank rejected — nothing written
  tasks/2026-11-17--call-the-bank: assignee: broken reference users/nobody
✖ tasks/2026-11-17--call-the-bank rejected — nothing written
  tasks/2026-11-17--call-the-bank: due: expected a real date, YYYY-MM-DD
```

A refused command exits with status 1 and leaves the disk as it was. The `set` changed the `status` line, added `tags`, and touched nothing else in the file.

**5. Add a collection of your own, and extend one you installed.** Your own schema lives in a module under `modules/` — a folder whose `package.json` has a `dreamteamer` key.

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

The first file is a new collection. The second is an *overlay*: it adds a field to `tasks` without touching the installed package. Both work on the next command; there is nothing to compile first.

```bash
dtx add recipes "Shakshuka" --cook dana-oren --course main --steps "# Method

Simmer the sauce, crack in the eggs, cover for five minutes."
dtx set tasks/2026-11-17--buy-milk recipe=shakshuka
```

**6. Check the workspace, and try to delete something that is in use.**

```bash
dtx check                                       # 3 records · 13 collections · 4 modules · 0 errors · 0 warnings
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

**7. Give the schema to an agent.**

```bash
dtx compile
```

This writes `.dt/AGENTS.md` — how to run the engine, then every collection with its fields, types, allowed values and id rule, and every skill your modules ship — and `.dt/model.json`, the same model for tools. Point your agent at `.dt/AGENTS.md`. The `.dt/` folder ignores itself in git and can be deleted at any time. `compile` also writes `.dreamteamer/`, the layout the released engine compiles, for tools that read it (see [Compile](#compile)); add it to your `.gitignore` too.

**8. Commit.** The engine never runs git. What it wrote is ordinary files:

```bash
git add .gitignore package.json package-lock.json modules data
git commit -m "A workspace with tasks, users and recipes"
```

### Working on a workspace you already have

```bash
dtx check -w /path/to/workspace
```

`modules`, `collections`, `list`, `get` and `check` write nothing. `compile` writes only `.dt/` and `.dreamteamer/`. `add`, `set` and `rm` change records in the workspace you name.

### If you are an agent

Run `compile` and read `.dt/AGENTS.md`: it gives the command to run and, for each collection, the fields you can set. Then:

- Write with `add` and `set`, not by editing files, and run `check` after any hand edit.
- Type a value as it is. Text is stored as text whatever it contains; a list is given by repeating the flag or separating values with commas; a reference to one collection can be given as the bare id.
- `rm` refuses a record that others point at. Fix the records it lists; `--force` is for when breaking them is what you mean.
- `list` takes `--filter field=value`, more than once, and `--json`.

## Concepts

| | |
|---|---|
| **Workspace** | A folder — normally a git repository — whose `package.json` lists the modules it uses. Your records live under `data/` |
| **Module** | An npm package, or a folder under `modules/`, whose `package.json` has a `dreamteamer` key. It ships collections, mixins and skills |
| **Collection** | A typed set of records: where they are stored, how their ids are made, and their fields. Described by a `<name>.collection.yaml` file |
| **Record** | One file: `data/tasks/2026-11-17--buy-milk.task.md`. Fields are YAML frontmatter; one field may be the Markdown text below it |
| **Reference** | A field that points at another record, always written `<collection>/<id>`, and always checked |
| **Overlay** | A descriptor marked `overlay: true` that adds fields to a collection another module owns |
| **Mixin** | A partial descriptor that several collections share by listing it under `mixins` |
| **Skill** | A `SKILL.md` a module ships: know-how an agent loads when a situation calls for it |
| **System module** | The engine's own module, `dreamteamer`: `repos`, and the collections whose records are the files modules ship (`collections`, `modules`, `skills` …) |

## How it works

```
package.json ──┐                          ┌──► store ◄──► data/    your records
node_modules/ ─┼─► discover ─► model ─────┤
modules/ ──────┘                          └──► compile ──► .dt/, .dreamteamer/    derived, disposable
```

### Where things live

| Path | What it is | Who writes it |
|---|---|---|
| `package.json` | Which modules the workspace uses | you, through npm |
| `node_modules/<module>/` | Installed modules. Read-only: the engine never writes here and never runs code from here | npm |
| `modules/<name>/` | Your own modules | you |
| `data/…` | Your records, one file each | `add`, `set`, `rm` — or you by hand, followed by `check` |
| `dreamteamer-exports.json` | Ids that live in another repository and are vouched for; references to them are accepted | read-only here |
| `.dt/` | What `compile` wrote | `compile` only |
| `.dreamteamer/` | The released engine's compiled layout, for the tools that read it | `compile`, which replaces its kind folders and `manifest.yaml` and leaves the rest |

### Modules

The workspace's modules are the packages named under `dependencies` and `devDependencies` in its `package.json` that carry a `dreamteamer` key, followed by every such folder under `modules/`. A package that arrived only as another package's dependency is not one of the workspace's modules until you list it.

**The system module.** Before all of them comes the engine's own module, `dreamteamer`, which every workspace has: the `entity` and `docs` mixins, the `using-dreamteamer` skill, the `dreamteamer` agent, and the system collections — `repos`, an ordinary collection whose records live in `data/repos`, and eight *source* collections whose records are what modules ship as files:

| Collection | A record is | Its id |
|---|---|---|
| `collections` | a collection of the model, read from the descriptor that declares it | its name, namespace included (`collections/rnd/design-docs`) |
| `modules` | a module, read from its `package.json` | its name without the npm scope (`modules/rnd` for `@dreamteamer/rnd`) |
| `skills` | a folder under a module's `skills/` holding a `SKILL.md` | the folder's name |
| `mixins`, `agents`, `commands`, `command-bindings`, `ui-views` | a file under the module's folder of that name | its path there, less `.<suffix>.<format>` (`commands/rnd/plan` for `commands/rnd/plan.command.md`) |

A reference to a source record resolves from the model; `list` and `get` answer for them, and `add`, `set` and `rm` refuse them, because a source changes in its module. These files are the released engine's, version 0.49.1, copied byte for byte into this repository's `collections/`, `mixins/`, `skills/` and `agents/` folders. A workspace that also lists the released `dreamteamer` package gets this copy, once, instead of the package's.

From a module the engine reads:

- `collections/**/*.collection.yaml` — collection descriptors and overlays
- `mixins/**/*.mixin.yaml` — mixins
- `skills/**/SKILL.md` — skills, indexed by name and description
- from its `package.json`: `title`, `namespaces`, `dependencies` and `peer_collections`

### The schema

The schema is resolved in memory, on every command, straight from those files. There is nothing to keep fresh: edit a descriptor and the next command sees it.

1. A collection's `name` is its name, namespace included (`rnd/design-docs`). The mixins it lists are merged first, then the descriptor on top. Unless it says otherwise, records live under `data/<name>` as Markdown and ids come from `{{ name | slug }}`.
2. An overlay adds fields to a collection another module owns. An overlay of a collection that is not installed is skipped: that is how a module extends an optional peer.
3. A field's type is a scalar, an installed collection, or a collection that a module lists under `peer_collections`. A declared peer that is not installed keeps its field; a value there must name that collection and is otherwise left unresolved. Anything else — a misspelt type, say — is an error, and an error in the schema stops every write until it is fixed.

4. How a collection is drawn is carried in the model as written, for whatever presents it: `title`, `record_title`, `internal`, `sensitive`, `constraints` (not enforced) and `display` — the descriptor's own `nav`, `list`, `record` and `form` sub-blocks completed key by key from its mixins', with an overlay's keys winning over both. A field keeps every key it was written with, its own `display` and `title` included.

**Field types:** `string`, `markdown`, `url`, `email`, `date`, `datetime`, `integer`, `number`, `boolean`, `object`, `map`, `position`, `reference` (a record of any collection), a collection name (a record of that collection), or a list of collection names (a record of any of them).

**Field keys:** `many` (a list), `required`, `default`, `enum`, `pattern`, `minimum`, `maximum`, `minLength`, `maxLength`, `soft` (a reference that need not exist yet), `body` (the field that is the Markdown text of the file), `description`.

### Records

A record is one file, `<storage.path>/<id>.<suffix>.<format>`. The suffix is the collection's name in the singular — `tasks` gives `task`, `companies` gives `company`, `rnd/user-stories` gives `user-story` — unless the descriptor sets `storage.suffix`. The id is the file's path inside the collection's folder, so an id may contain slashes.

Markdown, YAML and JSON records are supported, and so are folder-shaped records (`storage.shape: folder`): a folder holding an entry file, with room beside it for whatever belongs to the record.

**Ids.** `add` uses `--id` when you give one. Otherwise it takes the first template in the collection's `ids.from` whose fields are all present. The filters are `slug`, `date` with an optional format such as `date:YYYY/MM`, `basename` and `pad`. A name with accents loses them; a name with no Latin letters or digits becomes a short hash, and the engine tells you so.

**Validation** runs before anything is written, and across the whole workspace in `check`:

- the id matches the collection's pattern;
- every required field is present, and there are no unknown fields;
- each value has its field's type, is one of its allowed values, matches its pattern and lies within its bounds;
- a date is a real date, a date and time has a zone, a URL has a scheme;
- every reference names an existing record of an allowed collection.

**Safe writes.**

- A refused write changes nothing.
- A write goes to a temporary file that replaces the record in one step, so a record is never left half-written. If the record changed on disk after the command read it, the write is refused and can be retried.
- `set` rewrites only the lines of the fields it changes. Comments, quoting and everything else in the file stay as they were written.
- A reference or an id cannot name anything but a record of its collection: an empty id, `.` or `..`, a leading slash, a different case from the file's name, and a symbolic link out of the collection's folder are all refused.
- `rm` refuses a record that other records reference, and a folder-shaped record that holds other records.

**Reverse fields.** A field declared `mirror_of: <field>` is the other side of a reference: `users.tasks` lists the tasks whose `assignee` is that user. It is written by the engine, never by hand. When `add`, `set` or `rm` changes a reference, the records it now points at and the ones it stopped pointing at are rewritten too, one line each; a list is kept sorted and an empty one is removed. `check` reports a reverse field that has fallen behind — after a hand edit, say — and `relations rebuild <collection>` recomputes it from the owners.

### Compile

`compile` writes three files into `<workspace>/.dt/`:

| File | For | Content |
|---|---|---|
| `AGENTS.md` | an agent | how to run the engine; every collection with its description, when to use it, where its records live, how its ids are made, and each field with its type, allowed values and default; every skill with its description and path |
| `model.json` | tools | the entire resolved model, with paths relative to the workspace |
| `.gitignore` | git | `*` |

It also writes into `<workspace>/.dreamteamer/` the layout the released engine compiles, because the protocol host and several modules' scripts read it directly. Only what those readers use is written:

| Path | Content |
|---|---|
| `collections/<name>.collection.yaml` | each collection, compiled: its keys as written (storage and ids resolved, `display` and the rest as in the model), and a `compiled` block with `defaults` (the title, record title and layouts nobody wrote), `module`, `repo`, `runtime`, `overlaid_by` and `fields` — every field with its title, `id`, `created` and `last_modified` first, a reference given `on_delete: restrict` unless it says otherwise |
| `modules/<id>.module.yaml` | each module: `name`, `title`, `namespaces`, `location`, `path`, `dependencies`, `peer_collections`, `collections` |
| `skills/<id>/…`, `agents/`, `commands/`, `command-bindings/`, `ui-views/`, `mixins/` | each module's source files, copied as they are; a skill with its whole folder |
| `manifest.yaml` | `compiled`, `host`, `engine`, `namespaces`, `package`, `data_path`, `layers`, `modules` (`name`, `location`, `channel`, `root`), `ui`, and `entries`: for each file above, the source it came from |

Read through the released engine's own accessors, these descriptors give the same `presentation()` as the released compile for every published collection measured except binary ones. Not written: source hashes, `json_schema`, the workspace's own module record, a view's merged `compiled.display`, harness files and a `.gitignore`.

No command reads any of this back, so a stale `.dt/` or `.dreamteamer/` cannot make a command wrong. Run `compile` again after you change modules or descriptors.

### Git

Nothing commits by itself. `add`, `set` and `rm` change files and stop; staging and committing are yours. The command line never runs git. The engine API below does, when a host asks for a record's history, a revert or a commit: through one helper (`src/api/git.ts`) that checks every revision it is given, and a commit stages exactly the record files it names.

### The engine API for hosts and the Web UI

`src/api.js` is the released engine's public API, version 1, answered by this engine: the store, the descriptor accessors, `presentation()`, filters and sorts, history, rename, revert and commit. The DreamTeamer protocol host, `dt web` and the Web UI load it unchanged. Mount this checkout as the workspace's engine through a link — `node_modules/dreamteamer` as a symlink, or a `git_modules/dreamteamer` clone — not a copy: Node will not run TypeScript from inside `node_modules`, and a link resolves to a real path outside it. `bin/dreamteamer.js` runs this engine's command line under the released name, with a minimal `init`. Through the API the engine reports compatibility level 0.49.1, the system module's version, so modules' engine floors are met.

Measured: the protocol's own contract suite passes 59 of 90 cases; the 31 failures are the schema-editing operations, which are not built (26), and record layers (5). `presentation()` is identical to the released engine's for every published collection. The unchanged `dt web` serves a sample workspace of 35 modules and 287 records with its nav, lists, record pages and edits.

`src/api.js` is plain JavaScript that only re-exports the TypeScript behind it — the one place this repository re-exports, because the API's file and names are fixed by its consumers.

## Command reference

```
dtx <verb> [target] [arguments] [-w <workspace>]
```

| Verb | What it does | Example |
|---|---|---|
| `modules` | Lists the workspace's modules | `dtx modules` |
| `collections` | Lists its collections | `dtx collections` |
| `list <collection>` | Prints ids, sorted. `--filter field=value` narrows; `--json` prints the records. A source collection (`skills`, `collections` …) lists what the modules ship | `dtx list tasks --filter status=todo` |
| `get <ref>` | Prints a record's fields as JSON. `--json` adds its ref, id and path. A source record is read from the model or its module's file | `dtx get users/dana-oren` |
| `add <collection> ["title"]` | Creates a record. Refused for a source collection | `dtx add tasks "Buy milk" --due 2026-12-01 --tags home,errand --urgent` |
| `set <ref>` | Changes fields. An empty value clears one, or puts back its default. Refused for a source record | `dtx set tasks/2026-11-17--buy-milk status=done due=` |
| `rm <ref>` | Deletes a record. `--force` deletes one that others reference. Refused for a source record | `dtx rm tasks/2026-11-17--buy-milk` |
| `relations rebuild <collection>` | Recomputes the collection's reverse fields from the records that point at it | `dtx relations rebuild users` |
| `check` | Validates every record and reports files it does not recognise. Changes nothing | `dtx check` |
| `compile` | Writes `.dt/`, and the released compiled layout into `.dreamteamer/` | `dtx compile` |
| `help`, `--version` | | `dtx help` |

- The verb comes first. `-w <path>` names the workspace; the default is the current directory.
- A field is given as `--<field> <value>`, `--<field>=<value>` or `<field>=<value>`.
- A value is converted by the type of its field. Text is stored as typed. A number or `true`/`false` becomes one where the field is numeric or boolean, and a boolean flag with no value means true. A list takes a repeated flag, or one value with commas. A field that points at one collection takes a bare id. A date and time typed without seconds or a zone is completed with this machine's zone. An `object` or a `map` is written as YAML or JSON.
- A collection may be named in the singular: `dtx get task/2026-11-17--buy-milk`.
- Exit status: 0 on success, 1 when a command is refused or fails, 2 for an unknown verb. A failure is one line that says what to do.

## Using it from a script

Everything the command line does goes through the functions under `src/`; the command line only reads its arguments and prints. A script calls the same functions, each imported from the file that defines it:

```ts
import { buildModel } from "/path/to/dreamteamer-first-principles/src/model/buildModel.ts"
import { add } from "/path/to/dreamteamer-first-principles/src/store/add.ts"
import { list } from "/path/to/dreamteamer-first-principles/src/store/list.ts"
import { check } from "/path/to/dreamteamer-first-principles/src/store/check.ts"

const model = buildModel("/path/to/my-workspace")
const record = add(model, "users", { name: "Sam Diaz" })
console.log(record.ref, list(model, "users", { kind: "human" }).map((t) => t.id))
console.log(check(model).issues.filter((t) => t.severity === "error"))
```

The functions are `buildModel`, `discover`, `findCollection` and `splitRef` in `src/model/`; `listIds`, `list`, `get`, `add`, `set`, `rm`, `referrers`, `check` and `validate` in `src/store/`; `compile` and `instructions` in `src/compile/`; `stamp` and the `DtError` class in `src/lib/`; and the types in `src/types/`. `package.json` maps `./*` to `./src/*`. A refused call throws a `DtError` whose `issues` array says why. Values are taken as they are given; converting text by a field's type is the command line's job.

## Design principles

- **Plain files.** All state is Markdown, YAML and JSON in the workspace. Nothing is hidden in a database or a cache.
- **Schema first.** Every record conforms to a schema, every write is validated against it, and the schema is what an agent is given.
- **Relational.** References between records are typed and checked, on write and on delete.
- **Modular.** Schemas and skills are npm packages; a workspace composes them, adds its own, and overlays what it needs to change.
- **One workspace owns the data.** Modules are read-only inputs. Every write lands in the one workspace a command names.
- **No hidden steps.** No compile before a change takes effect, no commit behind your back, no module code run. Git runs only when a host asks the engine API for history, a revert or a commit.
- **Derived state is disposable.** Everything generated is in `.dt/` and `.dreamteamer/`, and can be deleted.
- **One interface.** The command line and a script call the same functions; rules about records live in one place.
- **Typed, and checked at the edge.** Types hold inside the engine; everything read from disk is validated before it is trusted.
- **Small enough to read.** One runtime dependency, and a budget on the size of the engine.

## What is not supported yet

- The contents of an `object` or a `map`, uniqueness, and a collection's cross-field `constraints` are not enforced.
- A module's commands, agents, command bindings and UI views are read as records, and nothing more: they are not delivered to an agent harness or acted on. Navigation and extensions are not read.
- The `using-dreamteamer` skill the system module ships describes the released engine's verbs, several of which this engine does not have.
- Instructions are compiled into `.dt/`, not into the files each agent harness loads.
- The command line has no `commit`, `rename`, `history`, `install` or `init`; the engine API has the first three, for hosts. The schema-editing operations (adding, changing and removing fields, collections, modules, views and skills) are not built.
- Record layers (`git_modules`) are not read, so neither are records a workspace takes from another repository.
- Extensions are not loaded, so a module's extension verbs, checks and notes do nothing.
- Binary records, such as the pictures in `@dreamteamer/assets`, cannot be read or written.
- The engine cannot be installed as an npm package: Node will not run TypeScript from inside `node_modules`.

[GAP-2.md](GAP-2.md) lists each of these with what it would take to add.

## Security

[Standard AI agent security measures](https://code.claude.com/docs/en/security) apply: the engine adds no capability to an agent, only a governed way to do what it could already do. Never give an agent credentials, tokens or keys, and treat a private workspace as private.

- **It executes no module code.** It reads YAML, JSON and Markdown from a module's folder and nothing else.
- **A module is still trusted input.** Its descriptors decide where records are stored and supply the patterns values are matched against. Vet a module before you install it.
- **A reference is not a path.** One that is empty or contains `.` or `..` is refused by every verb, so a reference taken from an agent or another program cannot reach a file other than a record of the collection it names.

## Development

```bash
npm test               # node --test: the API, the command line, and the published modules
npm run typecheck      # tsc, strict, emits nothing
npm run lint           # ESLint with typescript-eslint's type-aware rules
npm run format         # Prettier; format:check only verifies
```

The source is TypeScript that Node runs directly, so it uses only syntax that can be erased — no enums, no parameter properties — and imports carry their `.ts` extension. Each file is named after the one thing it exports, and there is no index and no re-export:

| Folder | What it holds |
|---|---|
| `src/types/` | The shared types: `Module`, `Collection`, `Field`, `Model`, `DtRecord`, `Issue`, `Skill`, `Descriptor` |
| `src/lib/` | `DtError`, and the readers every input from disk passes through (`asString`, `asObject`, `asArray` …) |
| `src/model/` | Finding the modules (`discover.ts`) and resolving them into one model (`buildModel.ts`) |
| `src/store/`, `src/yaml/` | Reading, validating and changing records, and editing a record's YAML a line at a time |
| `src/compile/` | Writing `.dt/` and `.dreamteamer/` |
| `src/cli/`, `bin/dt.ts` | The command line: `main.ts` parses and dispatches through the table in `VERBS.ts`; each verb is one file in `src/cli/verbs/` with its usage line, its options and its handler |

`test/engine.test.ts` drives the API on a throw-away workspace of invented modules, `test/cli.test.ts` runs the command line as a process, and `test/published.test.ts` runs the engine on published modules — tasks, users, companies, contacts, assets, meetings and rnd — pinned to exact versions as development dependencies. The house style is in [CLAUDE.md](CLAUDE.md). The engine has a budget of 7,000 lines; before adding to it, check that the addition has a demonstrated job.

## License

[Apache-2.0](LICENSE)
