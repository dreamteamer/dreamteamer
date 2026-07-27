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

## parity status (closed 2026-07-27)

The six known gaps are closed. Every extension operation now has a CLI verb, verified in a
throwaway `dreamteamer init` workspace (9/9 assertions, `check` clean):

| extension op | engine function | CLI |
| --- | --- | --- |
| edit a field (`PATCH /schema/collections/:c/fields/:f`) | `schema-ops.updateField` | `<c> update-field --name <f> --type <t>` |
| remove a field (`DELETE …/fields/:f`) | `schema-ops.removeField` | `<c> remove-field --name <f>` |
| delete a collection (`DELETE /schema/collections/:c`) | `schema-ops.removeCollection` | `collections rm <name> [--force]` |
| revert a record (`POST …/records-revert`) | `Store.revert` | `<c> revert <id> --hash <sha>` |
| record history / diff (`GET /history`, `/history-diff`) | `history.js` | `<c> history <id>` / `<c> diff <id> [--hash]` |
| create/update/delete a ui-view (`POST/DELETE /schema/ui-views`) | `saveUiView` / `removeUiView` | `ui-views add|set|rm` |

Notes worth keeping:

- `src/history.js` exists because that logic was inlined in `server.js` AND copy-pasted into the
  extension's `api.ts` with no CLI anywhere. Three callers, one implementation. It resolves a
  SYSTEM-stored record (collection, ui-view, skill…) back to its manifest sources — reading
  `.dreamteamer/` directly is useless, that path is gitignored.
- `ui-views set` takes dotted keys (`options.sort=-date`, `nav.label=Recent`) and derives the
  record id from `path` with the descriptor's own `{{ path | slug }}` rule, so a view saved from
  the CLI and one saved from the Layout options panel land on the SAME record.
- `revert` requires `--hash` on purpose. A revert with an implied target destroys the wrong record.
- Testing the CLI from a cwd inside a workspace runs THAT workspace's `git_modules/dreamteamer`,
  not the checkout you are editing (self-shadowing, decision 24). Test from outside, or import
  `src/cli.js` directly.

## how to keep it closed

When you add an engine capability, the CLI verb is part of the change, not a follow-up. When you
add an extension gesture, the verb must already exist. A route in `server.js` or the extension's
`api.ts` with no CLI equivalent is a gap — re-derive this table rather than trusting it.
