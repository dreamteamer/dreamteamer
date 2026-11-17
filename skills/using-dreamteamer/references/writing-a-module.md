# writing a module — scaffold, setup, test, gate, publish

A module is one npm package whose `package.json` carries a `dreamteamer` block. Writing one needs the
engine and nothing else: no helper package, no file copied from anyone's repository. You develop it
inside a workspace (the inline `modules/<id>` channel is dev mode), test it on the real engine, prove
it publishable with one command, and `npm publish`. A consumer then runs `dt install <name>`.

## 1. scaffold

```bash
dt add modules --name acme --extension --package @acme/acme --description "Acme records."
```

That writes, and commits in one scoped commit:

- `modules/acme/package.json` — `name` `@acme/acme`, `version` `0.1.0`, `type` `module`, a `files`
  list covering every kind folder plus `src` and `README.md`, `devDependencies.dreamteamer` pinned to
  the engine you ran, and `dreamteamer.engine: ">=<that version>"` — the floor the module is written
  against.
- `modules/acme/src/extension.js` — `activate(dt)` returning one setup unit (below).
- `modules/acme/README.md` — the install line and the develop/test/gate loop.
- `modules/acme/test/module.test.mjs` — one test on `dreamteamer/testing`, run by `npm test`.
- every kind folder (`collections/`, `skills/`, …) for the content you add.

Without `--package` the module stays private (folder = package name = id); without `--extension` there
is no `src/`. `dt compile && dt status` makes it live in this workspace.

## 2. the manifest rules

- **`dreamteamer.engine`** is the one floor the engine reads (`dt install`, compile, `--alone`). Raise
  it when you use something a newer engine added.
- **`devDependencies.dreamteamer`** is where your own tests get an engine.
- **an npm peer dependency on `dreamteamer`** is optional and conventional; a miss prints `dt update --engine`.
- **never `dependencies.dreamteamer`** — npm would nest a second engine beside the workspace's, and
  your code would disagree with the engine the operator ran. `dt check` names it.
- No new keys: `dreamteamer` is a closed set, and an unknown key fails compile on every engine.

A module never imports the engine and never imports another module. The engine reaches your code as
`activate(dt)`, with `dt` the running engine's API.

## 3. setup — the unit

A module that needs something per machine (a token, a folder, a download) declares a setup unit. The
scaffold's, with its comments removed:

```js
const KEY = 'ACME_TOKEN';
function inspect(ctx) {
  return { checks: [{ id: 'acme.token', status: ctx.env[KEY] ? 'configured' : 'missing', title: KEY, fix: 'dt setup acme --input token=<token>' }] };
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
  return { setup: [{ id: 'acme', version: 1, inputs: [{ id: 'token', kind: 'string', env: KEY, required: true }], inspect, plan }] };
}
```

- **`inspect` is synchronous and read-only** — `dt status` calls it without awaiting; an `async`
  inspect is refused at load, one that returns a Promise reads `blocked`.
- **An `env` action is the engine's to perform.** Name the keys and values; the engine writes `.env`:
  inside the workspace only, every other line kept, refused (`blocked`, nothing written) when git would
  commit `.env`, when a key is assigned twice, or a value holds `"`, `$`, a backtick or a carriage return
  (a shell sourcing `.env` would read it differently), and refused (`failed`, exit 1) when `.env`
  changed after the plan. A value already in the file is `done`, however it got there. The value is never printed. A value not yet known
  (`undefined`) makes the action `needs-input`; a key already holding its value makes it `done`.
  Every key must be in `dreamteamer.env` or `vars`.
- **`.env` is the only file the engine writes for a unit** (0.48.0). Anything else your unit makes —
  a download, a venv, a receipt under `ctx.receiptDir` — is an `apply` action with its `effects`
  (`download`, `network`, `machine`, `account`), and the engine asks consent for each.
- **`apply` is optional.** A unit whose actions all carry `env` needs none; a non-env action from a
  unit without `apply` fails by name.
- A check's `fix` is printed whole; a thrown error, a failed `apply` message and an action's `reason`
  are redacted (values after `key=`, e-mails, home folders, long tokens).

`references/extensions.md` has the full contract and the `ctx` each verb hands over;
`references/setup.md` how a person drives it.

## 4. test — `dreamteamer/testing`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createWorkspace, install, run } from 'dreamteamer/testing';

test('installs, and asks for its token', () => {
  const ws = createWorkspace();                                       // dt init on the engine running this test
  const r = install(ws, fileURLToPath(new URL('..', import.meta.url))); // packed with npm pack, then dt install
  assert.equal(r.status, 3);                                     // 3: a required input is still missing
  assert.match(run(ws, ['status']).stdout, /acme\s+configured\s+ACME_TOKEN missing/);
});
```

Run it with `node --test`. Every helper spawns the engine as a consumer does; `ENGINE` is the
`dreamteamer` your `devDependencies` installed, never one on `PATH`. `DT_ENGINE_DIR=<checkout>`
points `createWorkspace` at another engine (CI against an unreleased one). `run(ws, args, { env,
input, timeoutMs })` — `status` is `null` when a run hit its timeout.

## 5. gate — `--alone`

```bash
dt check modules/acme --alone
```

Packs the module, installs it into a fresh workspace on this engine with only its declared
`dreamteamer.dependencies` (packed from this workspace, never fetched), compiles, checks, and prints
its setup line. **Exit 0 is publishable** — including a unit still waiting for an input a stranger
will give. Exit 1 names what is wrong (a dependency not held here, a module preset member named with
its pin, a floor above this engine, a `files` list that leaves out a source the module authors — a kind
folder, its UI bundle, its nav fragment — a compile or check error); 2 is usage. `--keep` leaves the temp
workspace. It does not run your `npm test` — run both. It packs with `--ignore-scripts` (it runs none of
your code); `pack()` in your own tests runs your `prepack`. A module that builds in `prepack` ships its
built files in `files`, or the gate judges the unbuilt package.

## 6. publish

```bash
cd modules/acme && npm publish --access public
```

A consumer: `dt install @acme/acme`, then `dt setup acme --input token=<token>`.

## what a pin buys

`dreamteamer/testing` and `dreamteamer/records` are 0.x exports: a breaking change lands in a minor
and is announced one release ahead in `UPDATING.md`; a removed name keeps working one release with a
deprecation line on stderr.
