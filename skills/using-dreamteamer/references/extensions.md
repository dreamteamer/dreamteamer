# extensions — optional tools, and the one seam they plug into

Core is records plus the workspace compiler. Anything with a lifecycle of its own — a server, a
Docker host, a behaviour-test runner, an exporter to one vendor — is an **extension**: code the engine
calls, which a workspace has when it wants that capability and does without otherwise.

The verbs that left core in 0.31.0 — `prove` · `land` · `worktree`, `serve`, `notebooklm`, and the
Docker host — return as extensions, and **none is published yet**. Typed against core, each fails with
exit 2 and says so. A workspace that needs one now carries it as its own module (below), or stays on
0.30.x.

`dt status` lists the extensions this workspace loaded, and `dt help` appends each one's usage.

## how a workspace turns one on

Two places, one declaration — a `package.json` carrying `"dreamteamer": { "extension": "./entry.js" }`:

- **a workspace module**, `modules/<id>/package.json`. Its code is the workspace's own, like `bin/`,
  so it needs no package and no npm. This is how a workspace carries an extension nobody has
  published, and it shadows a dependency of the same name.
- **a direct dependency.** npm put the code there on purpose; a transitive package is never loaded
  however it advertises.

A bare entry in `dreamteamer.disable` switches one off while leaving it in place. Two extensions
claiming the same verb, source kind or harness is a refusal at load, naming both — never "last one
wins".

An extension is ALSO a content module (its `dreamteamer` key makes it one): its collections and skills
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

The `draft` is data only: the staged entries, the final merged descriptors, the modules, declared var
and env key NAMES, and the previous manifest. No writer, no Store, no environment values — an analysis
that needs one is a command, not an analysis.

## a module, or an extension?

A **module** ships collections, skills, commands, agents, views and UI code — content. An
**extension** ships code the engine calls. Reach for an extension only when the capability needs one
of the contribution keys above; everything else is a module, and a module is copied and adapted per
workspace rather than installed (`references/before-you-build.md`).
