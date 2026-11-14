# extensions — optional tools, and the one seam they plug into

Core is records plus the workspace compiler. Anything with a lifecycle of its own — a server, a
Docker host, a behaviour-test runner, an exporter to one vendor — is an **extension**: code the engine
calls, which a workspace has when it wants that capability and does without otherwise.

The verbs core does not ship live in packages: `prove` in `@dreamteamer/proofs`, `land` and
`worktree` in `@dreamteamer/worktrees`, `serve` in `@dreamteamer/http`, `notebooklm` in
`@dreamteamer/notebooklm`, and the container verbs in the global `dt-docker` bin. Typed without the
package, each exits 2 and prints its install line.

`dt status` lists the extensions this workspace loaded, `dt help` appends each one's usage, and
`dt doctor` shows what works on this machine — the engine's rows, then each extension's checks.

## how a workspace turns one on

Two places, one declaration — a `package.json` carrying `"dreamteamer": { "extension": "./entry.js" }`:

- **a module in the workspace**, `modules/<id>/package.json`. Its code is the workspace's own, like `bin/`,
  so it needs no package and no npm. This is how a workspace carries an extension nobody has
  published, and it shadows a dependency of the same name.
- **a direct dependency.** npm put the code there on purpose; a transitive package is never loaded
  however it advertises.

A bare entry in `dreamteamer.disable` switches one off while leaving it in place. Two extensions
claiming the same verb, source kind or harness is a refusal at load, naming both — never "last one
wins".

An extension IS a module (its `dreamteamer` key makes it one): its collections and skills
travel with its code, and compile discovers them like any other module's.

⚠ **Remove an extension and its kind goes with it.** A workspace holding `proofs/` folders with no
extension contributing `proofs` fails compile on the unknown folder — deliberately: a proof that
compiles with no validator would be a claim nothing checks. The next compile after a removal also
prunes the extension's compiled folder and its managed blocks.

## writing one — the contract

The entry's default export is `activate(dt)`. `dt` is the RUNNING engine's public API
(`import('dreamteamer')`'s namespace), so the extension never imports an engine of its own and can
never disagree with the one the operator ran. It returns a contribution; every key is optional:

| key | shape | what core does with it |
|---|---|---|
| `commands` | `{ <verb>: { usage, run(ws, argv) } }` | `dt <verb> …` runs it in-process with the opened workspace; the return is the exit code |
| `sourceKinds` | `[{ kind, exclude?: [subtree] }]` | compile stages `<module>/<kind>/` like a built-in kind; `exclude` keeps fixtures out |
| `analyze` | `(draft) → { errors?, warnings?, notes? }` | runs after assembly, before any output is replaced; an error fails the compile (and every schema write, which compiles) |
| `harnesses` | `{ <id>: (ctx) → { blocks: { <file>: text }, summary } }` | a harness adapter writing managed blocks into user-owned files |
| `orientation` | a string | one paragraph appended to every orientation block |
| `hooks` | `{ <ClaudeHookEvent>: '<dt verb args>' }` | merged into `dt install --print-adapters` |
| `check` | `({ root, ws, dt }) → [{ file, message }]` | `dt check` reports each as a violation after the schema's, attributed to the extension; a throw is a violation too |
| `doctor` | `({ root, ws, dt }) → [{ label, state: ok\|warn\|bad, detail?, fix? }]` | `dt doctor` renders the rows as one capability named after the extension: READY, DEGRADED (a warn) or UNAVAILABLE (a bad), each fix on its row |
| `next` | `({ root, ws, collection, ids }) → [{ id, text }]`, synchronous | `dt next <ref>` prints each line under the bound commands (`--json`: `notes`, attributed); a throw is one failure line, never a failed `dt next`. `contributedNotes(ws, collection, ids)` is the same call for a surface |

A module that needs per-machine setup (an account, a download, a local tool) declares it as a
**setup unit** — the `setup` contribution key: `[{ id, version: 1, inputs: [{ id, kind: 'string'|'path'|'rows'|'secret-path', env?, required?, default?, prompt?, rows? }], inspect(ctx) → { checks }, plan(ctx, inputs) → { checks, actions: [{ id, title, effects?: [{ kind, detail }], env?: { KEY: value }, state?, reason?, preview?, expect?, runBy?, kind? }], needs }, apply?(ctx, action, inputs) → { ok, changed, message? } }]`.
A unit is addressed by its `id` wherever it is installed (alone, or as a member a module preset installed); the engine
validates the shape at load, refuses two packages claiming one id, and drives every unit through `dt install`, `dt setup` and
`dt status` without knowing the module (`setup.md`). `doctor` renders a unit's checks as rows. An input's `env` must also be
declared in the package's `dreamteamer.env` or `vars`. A set of modules installed together is a **module preset** — a package
whose `dreamteamer.preset` pins its members (`collections.md`); `dreamteamer.provides` is legal and ignored since 0.49.0.

What the signature does not show:

- **an `env` action** — `{ id, title, env: { KEY: value, … }, state? }` — is performed by the engine, not by `apply`: the
  `.env` write, confined to the workspace, every other line kept, the value never printed. Judged when the plan is read:
  `done` when every key holds its value (whatever it holds — a value set by hand is never refused afterwards),
  `needs-input` for an `undefined` value, `blocked` (nothing written, exit 0) for an undeclared key, a non-string value, a
  key assigned twice, a value holding `"`, `$`, a backtick or a carriage return (or a backslash that would need quoting —
  a Windows path is written unquoted), a leftover temp file, a `.env` git would commit, or a key another unit wrote in the
  same run with a different value (two units may share a key, never disagree on it); a leading byte-order mark is kept; at write time a `.env` that changed after the plan is a failure (exit 1). A ready env action's `reason`
  is the unit's note on what it wrote or left out, printed after the write (redacted). `.env` is the only file the engine
  writes for a unit; anything else is an `apply` action with its effects.
- **`apply` is optional** — a non-env action from a unit without one fails by name. **`inspect` must be synchronous** — an
  `async` one is refused at load, and a plain one that returns a Promise reads `blocked` naming the fix (`dt status`
  reads it without awaiting).
- **redaction** touches failure text only — what a unit throws, a failed `apply` message, an action's `reason`; a check's
  `fix`, any `title` and the next command print whole.
- **the engine is never a module's `dependencies`** — `dt check` names one that lists it (a second engine would nest);
  `devDependencies` for the module's tests, an npm peer dependency optionally. `dreamteamer.engine` is the floor the engine reads.

The `ctx` each driver hands a unit:

| key | `dt setup` | `dt doctor` | `dt install` · `dt init` | `dt status` |
|---|---|---|---|---|
| `root`, `ws`, `env`, `receiptDir` | set | set | set | set |
| `tty` | the terminal | false | the terminal | false |
| `dt` | the engine's API | the engine's API | null | null |

`inspect` and `plan` must not depend on `ctx.dt`; a machine step that wants the API runs under `dt setup`.

Writing, testing and publishing a module end to end — the scaffold, `dreamteamer/testing`, `dt check modules/<id> --alone`
— is `references/writing-a-module.md`. `dreamteamer/testing` and `dreamteamer/records` are 0.x exports: a breaking change
lands in a minor, announced one release ahead in `UPDATING.md`.

The `draft` is data only: the staged entries, the final merged descriptors, the modules, declared var
and env key NAMES, and the previous manifest. No writer, no Store, no environment values — an analysis
that needs one is a command, not an analysis.

## a module, or an extension?

A **module** ships collections, skills, commands, agents, views and UI code — content. An
**extension** is a module that also ships code the engine calls (`dreamteamer.extension`). Reach for
an extension only when the capability needs one of the contribution keys above; everything else is a
plain module — look for one before writing it (`references/before-you-build.md`), and bring a
published one in with `dt install <package>` (`references/setup.md`).
