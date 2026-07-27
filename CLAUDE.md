# dreamteamer — the engine

`@dreamteamer/dreamteamer`: workspace compiler, CLI, store, schema-ops, sync. See `README.md` for
the contract (sources → `.dreamteamer/` → harness adapters; records are files; one git commit per
mutation; hard validation before disk).

## IMPORTANT — engine/UI split

**dreamteamer is the ENGINE. [dreamteamer-vscode](https://github.com/dreamteamer/dreamteamer-vscode)
is the UI.** All functionality lives here; the extension is a surface over it, never a second
implementation.

**The test:** *anything that can be done in the VS Code extension can be done in a Claude Code (or
any supported coding-agent) session.* Concretely — every extension gesture must map to a
`dreamteamer <…>` CLI invocation an agent can run headlessly, with the same validation, the same
sources touched, and the same commit shape.

Corollaries:

- A new capability starts here — engine function **plus a CLI verb** — and only then gets a button.
- The extension may not hand-write `system/` sources or `data/` records around the store. If it
  needs an operation, that operation is an engine export *and* is reachable from the CLI.
- Loading the engine in-process (what `dreamteamer-vscode/src/engine.ts` does) satisfies "one
  implementation" but **not** the test — an in-process-only export is still UI-exclusive until the
  CLI exposes it.
- `src/server.js` and the extension's `src/api.ts` are thin skins over these functions. If a route
  exists with no CLI equivalent, that's a gap, not a design.

## known gaps (verified 2026-07-27, engine @ git_modules clone)

Tested in a throwaway `dreamteamer init` workspace. These extension operations have **no CLI verb**
— an agent has to hand-edit the source file and `compile`, i.e. leave the validated path:

| extension op | engine function | CLI |
| --- | --- | --- |
| edit a field (`PATCH /schema/collections/:c/fields/:f`) | `schema-ops.updateField` | ✖ `update-field` unknown |
| remove a field (`DELETE …/fields/:f`) | `schema-ops.removeField` | ✖ `remove-field` unknown |
| delete a collection (`DELETE /schema/collections/:c`) | `schema-ops.removeCollection` | ✖ `collections rm` → "system sources" refusal |
| revert a record (`POST …/records-revert`) | `Store.revert` | ✖ `revert` unknown |
| record history / diff (`GET /history`, `/history-diff`) | git-backed | ✖ (git log by hand) |
| create/update/delete a ui-view (`POST/DELETE /schema/ui-views`) | `schema-ops.saveUiView` / `removeUiView` | ✖ `ui-views add` → "system sources" refusal |

Passing today: `collections add`, `<c> add-field`, `<c> list|get|add|set|rm|rename`, `workflows
run`, `init`, `compile`, `check`, `status`, `install`, `update`, `migrate`, `sync`, `start`.

Closing these means routing the existing schema-ops/store exports through `src/collections-cli.js`
meta verbs — the functions already exist and already commit correctly.
