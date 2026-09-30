# extensions — optional tools, and the one seam they plug into

Core is records plus the workspace compiler. Anything with a lifecycle of its own — a server, a
Docker host, a behaviour-test runner, an exporter to one vendor — is an **extension**: a separate
npm package the workspace installs when it wants that capability, and does without otherwise.

| package | adds | install |
|---|---|---|
| `@dreamteamer/workflows` | `dt prove` (behaviour proofs, the `proofs/` source kind), `dt land` (land a worktree's commits), `dt worktree` (cut, list, remove checkouts), and the worktree hooks | `npm i -D @dreamteamer/workflows` in the workspace |
| `@dreamteamer/http` | `dt serve` — the REST api at `/api` | `npm i -D @dreamteamer/http` |
| `@dreamteamer/notebooklm` | `dt notebooklm` (export, optionally sync) and the `notebooklm` harness (`NOTEBOOKLM.md`) | `npm i -D @dreamteamer/notebooklm` |
| `@dreamteamer/host` | `dt-host` — a workspace as a local Docker container; needs no workspace | `npm i -g @dreamteamer/host` |

Each ships its own skill; with the package installed and compiled, that skill is in the harness.
`dt status` lists the extensions this workspace loaded, and `dt help` appends each one's usage.

## how a workspace turns one on

**A direct dependency whose package.json declares `"dreamteamer": { "extension": "./entry.js" }` is
loaded — that is the whole declaration.** npm put the code there on purpose; a transitive package is
never loaded however it advertises. A bare entry in `dreamteamer.disable` switches one off while
leaving it installed. Two extensions claiming the same verb, source kind or harness is a refusal at
load, naming both — never "last one wins".

The same package is usually ALSO a content module (its `dreamteamer` key makes it one): the
`proofs` collection descriptor and the proving skill travel inside `@dreamteamer/workflows`, and
compile discovers them like any other module's.

⚠ **Remove an extension and its kind goes with it.** A workspace holding `proofs/` folders without
`@dreamteamer/workflows` installed fails compile on the unknown folder — deliberately: a proof that
compiles with no validator would be a claim nothing checks. The next compile after an uninstall also
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

The `draft` is data only: the staged entries, the final merged descriptors, the modules, declared var
and env key NAMES, and the previous manifest. No writer, no Store, no environment values — an analysis
that needs one is a command, not an analysis.

## a module, or an extension?

A **module** ships collections, skills, commands, agents, views and UI code — content. An
**extension** ships code the engine calls. Reach for an extension only when the capability needs one
of the contribution keys above; everything else is a module, and a module is copied and adapted per
workspace rather than installed (`references/before-you-build.md`).
