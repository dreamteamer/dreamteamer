# Extending dreamteamer

dreamteamer is modular: you extend it by writing modules. This guide takes you from an empty folder to a published one. It is the short version. The full reference is [writing-a-module.md](skills/using-dreamteamer/references/writing-a-module.md), which ships with the engine, so your agent can read it too.

You don't have to do any of this by hand. Asking your agent to "create a module for XXX" runs the same commands.

## What a module is

A module is one npm package whose `package.json` carries a `dreamteamer` block. It ships a domain as plain files, one folder per kind:

| folder | what it holds |
|---|---|
| `collections/` | the kinds of records, with their fields and relations |
| `skills/` | procedures an agent loads on its own when the situation matches |
| `commands/` | procedures you start by name (`command-bindings/` ties one to a record's state) |
| `agents/` | jobs that run in a context of their own |
| `ui-views/` | boards, lists and other ways to look at a collection |
| `mixins/` | fields shared by several collections |

Writing one needs the engine and nothing else. [`@dreamteamer/tasks`](https://github.com/dreamteamer/dreamteamer-modules/tree/main/modules/tasks) is a small real one to read.

### Plain module or extension?

- **A plain module is content.** Only the folders above. Most modules are this.
- **An extension is a module that also ships code** the engine calls: its own verbs, setup for what a machine needs (a token, a download), checks for `npx dreamteamer check` and `npx dreamteamer doctor`, and more.

Reach for an extension only when you need one of those. Everything an extension can contribute is listed in [extensions.md](skills/using-dreamteamer/references/extensions.md).

## 1. Scaffold

Inside any workspace (`npx dreamteamer init` makes one):

```bash
npx dreamteamer add modules --name northwind --extension --package @northwind/northwind --description "Northwind records."
```

This writes `modules/northwind/` and commits it:

- `package.json`, with the `dreamteamer` block, a `files` list and the engine floor (see [the rules](#the-rules));
- one empty folder per kind;
- `README.md` and `test/module.test.mjs`;
- `src/extension.js`, with one working setup unit.

Both flags are optional. Without `--extension` there is no `src/`. Without `--package` the module stays private to this workspace, named after its folder.

## 2. Develop it in the workspace

A module under `modules/` is live in the workspace it sits in, so you build it by using it:

```bash
npx dreamteamer add collections --name tickets --module northwind --description "A support ticket."
npx dreamteamer add-field tickets --name priority --enum low,high
npx dreamteamer add ticket "Printer on fire" --priority high
npx dreamteamer status
```

Schema verbs such as `add collections` and `add-field` compile and commit by themselves. Skills, commands, agents and views are files you write in the module's folders. After editing any of them:

```bash
npx dreamteamer compile     # or: compile --watch
```

Each kind has its own reference: [collections](skills/using-dreamteamer/references/collections.md), [skills](skills/using-dreamteamer/references/skills.md), [commands](skills/using-dreamteamer/references/commands.md), [agents](skills/using-dreamteamer/references/agents.md) and [ui-views](skills/using-dreamteamer/references/ui-views.md).

## 3. Setup, and the env action

An extension's entry file exports `activate(dt)`. `dt` is the running engine's API, and the function returns what the module contributes. A module never imports the engine, and never imports another module.

If your module needs something per machine, declare a **setup unit**. This is the one the scaffold wrote, which asks for a token and stores it:

```js
// modules/northwind/src/extension.js
const KEY = 'NORTHWIND_TOKEN';

function inspect(ctx) {
  return { checks: [{ id: 'northwind.token', status: ctx.env[KEY] ? 'configured' : 'missing', title: KEY, fix: 'dt setup northwind --input token=<token>' }] };
}

function plan(ctx, inputs) {
  const token = inputs.token ?? ctx.env[KEY];
  return {
    checks: inspect({ ...ctx, env: { ...ctx.env, ...(token ? { [KEY]: token } : {}) } }).checks,
    actions: [{ id: 'set-token', title: `write ${KEY} into .env`, env: { [KEY]: token }, state: token ? 'ready' : 'needs-input' }],
    needs: token ? [] : ['token'],
  };
}

export default function activate(dt) {
  return {
    setup: [{ id: 'northwind', version: 1, inputs: [{ id: 'token', kind: 'string', env: KEY, required: true }], inspect, plan }],
  };
}
```

The action carrying `env: { KEY: value }` is the **env action**. Your code names the key and the value, and the engine does the write: into the workspace's `.env`, keeping every other line, never printing the value, and refusing when Git would commit that file.

- **Declare every key** under `dreamteamer.env` in `package.json` (the scaffold did).
- **`inspect` is synchronous and read-only.** `npx dreamteamer status` calls it on every run.
- **Anything else is an `apply` action.** A download or a change to the machine names its effects, and the engine asks the person before running each one.

Whoever installs the module runs `npx dreamteamer setup northwind --input token=<token>`, and `status` shows the unit go from `configured` to `ready`. (`dt`, as in the `fix` line above, is the short name of the same CLI.)

## 4. Test

The engine exports helpers that run your module the way a stranger meets it: packed, then installed into a fresh workspace.

```js
// modules/northwind/test/module.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createWorkspace, install, run } from 'dreamteamer/testing';

test('northwind installs into a fresh workspace and checks clean', () => {
  const ws = createWorkspace();
  const r = install(ws, fileURLToPath(new URL('..', import.meta.url)));
  assert.ok([0, 3].includes(r.status), r.stdout + r.stderr);   // 3: an input is still to be given
  assert.equal(run(ws, ['check']).status, 0);
});
```

Run it from the module's folder, once its dev dependency on the engine is installed:

```bash
cd modules/northwind && npm install && npm test
```

`run(ws, args)` runs any verb in that workspace and returns `{ status, stdout, stderr }`. The other helpers are `pack`, `engineMeets` and `ENGINE`.

## 5. The publish gate

```bash
npx dreamteamer check modules/northwind --alone
```

This packs the module, installs it into a fresh workspace with only the dependencies it declares, compiles and checks. **Exit 0 means publishable.** Exit 1 names what is wrong: a dependency this workspace does not hold, a `files` list missing an entry, a compile or check error. `--keep` leaves the temporary workspace for you to look at.

The gate does not run your tests. Run both.

## 6. Publish and install

```bash
cd modules/northwind && npm publish --access public
```

Anyone can then add it to their workspace:

```bash
npx dreamteamer install @northwind/northwind
```

`install` brings in the module and every module it depends on, pins exact versions, compiles, runs the safe part of its setup and commits. It also takes a tarball or a folder, which is how you try a module before publishing it: `npx dreamteamer install ./northwind-northwind-0.1.0.tgz`.

## Where a module lives, from local to shared

A module can reach a workspace in five ways. Start at the top and move down only when you need to. The format is the same all the way, so moving is cheap.

| | the sources sit in | how they get there | use it when |
|---|---|---|---|
| 1 | `modules/<workspace module>/` | `init` creates it | the content is this workspace's own |
| 2 | `modules/<id>/` | `add modules --name <id>` | a domain deserves its own box, or you are building a module to share |
| 3 | `git_modules/<name>/` | `install --clone <url>` | you share through a Git repository, without a registry |
| 4 | `node_modules/`, from a file or a folder | `install ./x.tgz` or `install ./folder` | you try a module before it is published |
| 5 | `node_modules/`, from npm | `install <name>` | it is a versioned release for anyone |

When the same module arrives twice, the more local copy wins: `modules/` over `git_modules/` over `node_modules/`. `compile` warns, and `status` shows which copy shadows which.

### 1. The workspace's own module

Every workspace has one, named by `dreamteamer.workspace_module` in its `package.json` (`init` calls it `default`). `add collections` without `--module` lands there, and it is the right first home for anything.

**Moving up:** scaffold a module, then `npx dreamteamer set collections/<c> module=<id>` moves a collection into it. Records stay where they are.

### 2. An inline module

What [step 1](#1-scaffold) scaffolds: a folder in the workspace's own repository, live after every `compile`. This is where a module is developed, whether or not it ever leaves.

**Moving up:** the folder is already a package. Give it its own repository (3), pack or link it (4), or publish it (5). A module scaffolded without `--package` is marked `"private": true`; give it a real name and drop that line first.

### 3. A Git module

```bash
npx dreamteamer install --clone <url> northwind
npx dreamteamer compile
```

This clones the repository into `git_modules/northwind/` and records it in `package.json`:

```json
"dreamteamer": { "git_modules": { "northwind": { "url": "<url>", "ref": "main" } } }
```

On a fresh checkout, `npx dreamteamer install` restores every clone from that map, and `npx dreamteamer update` pulls each one forward on its `ref` (fast-forward only). A repository whose root holds a `modules/` folder delivers every module in it.

The same key attaches another **workspace**, which makes it a *record layer*: its records are read here, and its modules are not compiled. Two optional keys on the entry change that: `"records": ["tasks"]` reads only the collections listed, and `"module": true` also compiles that workspace's own module. What a layer itself needs from its own `git_modules` is cloned for you, and an entry you declare yourself overrides the layer's. See "record layers" in [collections.md](skills/using-dreamteamer/references/collections.md).

### 4. A tarball or a folder

```bash
npx dreamteamer install ./northwind-northwind-0.1.0.tgz             # what `npm pack` wrote
npx dreamteamer install ../northwind                                # a development link
npx dreamteamer install @northwind/northwind --from ./tarballs      # by name, from a folder of tarballs
```

A folder is linked, not copied: `status` marks it `(linked)`, it is not pinned, and `update` skips it. A tarball is the closest thing to a release without publishing one. `--from` works offline.

### 5. An npm package

`npx dreamteamer install <name>` takes the latest release, or `<name>@<version>` the one you choose, and pins it exactly. Nothing moves until `npx dreamteamer update <name>`.

### Changing a module you did not write

Don't edit an installed module. The workspace has three tools of its own:

- **An overlay** adds to another module's collection from yours. Declare the dependency once, then the field verbs write the overlay for you:

  ```bash
  npx dreamteamer set modules/default dependencies=modules/northwind
  npx dreamteamer add-field tickets --name urgency --enum low,high --module default
  ```

  An overlay can add or tighten fields, never remove one. A view can be overlaid too ([ui-views.md](skills/using-dreamteamer/references/ui-views.md)).
- **`dreamteamer.disable`** in the workspace's `package.json` drops a whole module, code included, or one entity as `<kind>/<id>`: `"disable": ["modules/northwind", "skills/working-with-tickets"]`.
- **A more local copy** shadows an installed one, as above. Use it to work on a module you also have installed, not to fork one quietly.

## The rules

**The engine**

- **`dreamteamer.engine` is the floor**, a range such as `">=0.48.0"`. The scaffold sets it to the engine you ran. Raise it when you use something a newer engine added. An engine below the floor refuses the module.
- **`devDependencies.dreamteamer`** is where your tests get an engine.
- **Never `dependencies.dreamteamer`.** npm would nest a second engine beside the workspace's own. `check` names a module that does this.
- A peer dependency on `dreamteamer` is optional.

**Other modules**

- **`dreamteamer.dependencies`** lists the modules yours cannot compile without. `install` brings them in. It must not form a ring.
- **`dreamteamer.peer_collections`** lists collections you reference but do not own, and that may be absent. Use it when two modules point at each other.
- **A minimum version of another module** is an npm `peerDependencies` range at the top level of `package.json`.
- **A reference field may only point at** an engine collection, one of your own, a dependency's, or a peer collection.

From `@dreamteamer/tasks`, trimmed:

```json
"dreamteamer": {
  "engine": ">=0.33.0",
  "dependencies": ["@dreamteamer/users"],
  "peer_collections": ["projects"]
},
"peerDependencies": { "@dreamteamer/users": ">=0.2.1" }
```

The `dreamteamer` block is a closed set of keys, and an unknown one fails the compile. The table of keys is in [collections.md](skills/using-dreamteamer/references/collections.md), under "declaring a module".

## Contributing to the engine

The engine itself is deliberately small, and most ideas belong in a module. See [CONTRIBUTING.md](CONTRIBUTING.md).
