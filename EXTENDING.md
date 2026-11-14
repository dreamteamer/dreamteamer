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

## Changing a module you did not write

Don't edit an installed module. Add an **overlay** in a module of your own: a descriptor that extends the collection, to add a field or change a label. The [modules repository](https://github.com/dreamteamer/dreamteamer-modules#making-a-module-yours) shows one.

## Contributing to the engine

The engine itself is deliberately small, and most ideas belong in a module. See [CONTRIBUTING.md](CONTRIBUTING.md).
