# dreamteamer-first-principles

An experimental, minimal TypeScript engine for DreamTeamer workspaces. [README.md](README.md) says what it does and
how it is meant to work; [GAP.md](GAP.md) lists what is missing and what has been closed. Read both before changing
behaviour, and keep both in step with the code in the same commit.

This repository is public. Nothing from a private workspace may appear in code, tests, comments, commit messages or
documents: no workspace or client names, no real record ids or contents, no personal names, no absolute paths of a
machine, no email addresses. Fixtures use invented data (Dana Oren, Northwind). Measurements keep their numbers and
never their source's name.

## Commands

```sh
npm install
npm test               # node --test, every suite in test/
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint, type-aware
npm run format         # Prettier; format:check to verify only
node bin/dt.ts <verb>  # the CLI; there is no build step
```

Before calling work done: `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test` all pass, and the
exit codes are quoted, not inferred.

## Budget

The engine — everything under `src/` and `bin/` — stays under 7,000 lines. Tests do not count. A cache, a service, a
database, a code generator or a new package needs a demonstrated job before it is added. Report the line count
(`wc -l` over `src` and `bin`) whenever a change adds to it.

## Rules

- **Refactoring is its own step and commit, before the feature.** When a feature first needs code moved, renamed or
  restructured, do that alone, with every check passing and no behaviour change, and commit it on its own.
- **No new package without a stated reason.** The one runtime dependency is `yaml`. Development tools are TypeScript,
  ESLint with typescript-eslint, Prettier, `@types/node`, and the published modules the tests run against.
- **Node runs the TypeScript directly.** No build, no bundler, no `tsx`. `tsc` only type-checks. The tsconfig sets
  `allowImportingTsExtensions`, `erasableSyntaxOnly` and `verbatimModuleSyntax`: no `enum`, `namespace` or constructor
  parameter properties, and type-only imports are written `import type`.
- **Imports name the real file with its extension** (`./lib/asString.ts`). No path alias, no `index.ts`, no
  re-exports: a caller imports a thing from the file that defines it.
- **A file is named after its main export**, in the same case: `buildModel.ts` exports `buildModel`, `DtError.ts`
  exports `DtError`.
- **Related files share a nested folder** inside `src` (`src/model/`, `src/store/`, `src/cli/`); the top level keeps
  the engine's main entry points. Generic helpers go in `lib/`, shared types in `types/`.
- **Names are short**: types and classes are real words or well-known abbreviations; parameters and variables shorter
  still. A name says what the thing is, not how it is used.
- **Functions use the `function` keyword** when they declare their own parameter types, however short. A const
  holding an arrow is only for short callbacks such as a `map`. An expression-bodied callback names its parameter
  `t` (`rows.map(t => t.id)`) unless `t` collides.
- **Never return an object literal directly; return a typed const.** `const res: Model = { … }; return res`. A
  literal returned from a contextually typed function skips TypeScript's excess-property check.
- **No object spread** (`{ ...x }`) unless nothing else works; write each field by name. Array spreads are fine.
- **No type annotation the compiler already infers.** Annotate where it adds a check, such as an object literal.
- **A type used once is written inline**; name it only when a second place needs it.
- **A lookup keyed by a union is `as const satisfies Record<Union, …>`.** Keep maps flat.
- **Untrusted input is read through readers, never cast.** Everything that comes from disk — a `package.json`, a
  descriptor, a record, a command line — passes through a reader in `src/lib/` (`asString`, `asObject`, `asOptional`,
  `asArray`, `asOneOf` …) that returns the typed value or throws. No `any`, no `as` on parsed data, no schema library.
- **Errors a user can cause are `DtError`s with one line that says what to do.** A stack trace is a bug.
- **One interface for every adapter.** The command line, generated instructions and anything else that presents the
  engine call the same functions; an adapter holds no rule about records.
- **The engine writes only inside the workspace it is given**, never into an installed package. It runs a module's
  code only through the extension loader (`src/extensions/`), for a module the workspace lists; nowhere else. A
  reference is not a path: validate it before it touches the file system.
- **Compatibility is measured, not asserted.** Behaviour that the released engine or a published module defines — a
  file name, an id, a verdict of `check` — is pinned by a test in `test/published.test.ts` or by a fixture that the
  released engine produced.
- **An interim answer to an open question is marked** with a doc comment line `Review: …` saying what is undecided.
- **Formatting is Prettier's** (`.prettierrc.json`: 2 spaces, no semicolons, 120 columns). Run `format`, never
  hand-format.
