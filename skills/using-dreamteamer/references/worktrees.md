# worktrees — a second checkout of this workspace, and the one verb that brings its records home

A **linked worktree** is a second working directory on the same repository: its own files, its own
branch, one shared object store. A session can work in one without touching the tree you are looking
at. `dt install` makes such a checkout ready; `dt land` brings its records back.

The whole design turns on one asymmetry. Two sessions writing records in the SAME directory is
conflict-BLIND — the second `dt set` on a record silently wins and nobody is told. Two sessions in
two worktrees make that same collision a **visible landing failure**, and the tree you were not
looking at is left byte-identical while you decide.

| the question | read |
|---|---|
| what a worktree costs to make ready | making one ready |
| add, list, get, rm | the four verbs |
| bringing the records home | landing |
| it refused — why | the refusals |
| it stopped on a conflict | the merge policy |
| a harness that cuts worktrees for you | hooks |
| `npm` is not on the hook's PATH | the shim |
| the other four harnesses | per harness |

## making one ready

```
dt install                 # in the worktree — engine, .env, local assets, git modules, compile, post-step
```

A fresh worktree has no `node_modules`, no `.env`, no compiled runtime and no local assets. `dt
install` is idempotent and prints a board of what it found and what it did; run it again and every
line says *already*.

Three things it does that a bare `npm install` cannot:

- **`.env` is LINKED from the primary — but only when the worktree lies under the primary's root.**
  A worktree elsewhere on the disk gets no credentials unless `--link-env` is passed for that run,
  and the board says which capabilities are degraded without them. Credentials are not widened by
  accident: a harness that keeps its worktrees under `~` gets an honest, credential-free checkout.
- **Declared local assets are linked, not copied.** `dreamteamer.local-assets` in a module's or the
  workspace's `package.json` names gitignored heavy folders — model weights, browser profiles — and
  the worktree gets a symlink to the primary's copy. A 1.5 GB download does not happen twice.
- **`dreamteamer.postinstall` runs LAST.** Deliberately not npm's `scripts.postinstall`: npm fires
  that on every install, before the engine has compiled, and in contexts where a slow environment
  step must not run at all.

⚠ **A worktree of a workspace running a SHADOWED engine inherits the shadow.** If
`node_modules/dreamteamer` or a `git_modules/<name>` entry is a symlink, `dt add worktrees` mirrors
that link into the new tree — so the copy compiles with the same compiler as the tree it was cut
from. Real clones under `git_modules/` are per-checkout working state and are restored by `install`,
never linked.

## the four verbs

```
dt add worktrees --name <n> [--path <dir>] [--base <ref>] [--temp]
dt list worktrees [--json]
dt get worktrees/<name|path> [--json]
dt rm worktrees/<name|path> [--force]
```

A worktree is **observed, never stored** — every row comes from `git worktree list` plus two cheap
reads. There is no record to drift from the truth.

`add` cuts the tree on branch `worktree-<n>`, runs `install` in it, and prints its absolute path
**last**, which is what a creation hook echoes. `--temp` is the sandbox form: detached, under
`.worktrees/.tmp-<rand>/<n>` inside the primary root, for a caller that will remove it.

⚠ **`rm` REFUSES by default, and names why.** A worktree holds two things the primary cannot see:
records written but not committed, and commits not landed. `git worktree remove` knows about
neither. A detached worktree's commits are reachable from nothing but the HEAD about to be deleted,
so the guard measures orphanhood rather than branch-ahead-ness — and if that measurement cannot be
taken, it refuses rather than assuming zero.

## landing

```
dt land worktrees/<name|path> [--keep] [--dry-run] [--branch <n>] [--json]
```

Run it **from the primary**. It rebases a COPY of the worktree's branch onto the primary branch,
fast-forwards, recompiles, and retires the worktree. `--dry-run` prints the plan and mutates
nothing. `--keep` leaves the worktree standing on the landed tip.

What it prints when it works:

```
✔ landed worktrees/w onto main: 1 commit(s)
  notes: 1 record(s)
  managed block regenerated: CLAUDE.md
  primary recompiled
  worktree and branch removed
```

The order matters and each step exists for a measured reason:

1. **One lock**, owned by the engine, at `<common-dir>/dreamteamer-land.lock`. A lock whose process
   is gone is reclaimed out loud; a live one is refused with its pid and age.
2. **A copy.** `land/<name>` is created from the worktree's branch and rebased in a throwaway
   detached worktree. The branch you are standing on is never touched until the fast-forward
   succeeds — which is what makes a failed landing leave every tree byte-identical.
3. **Recompile on the copy's tip**, then commit the regenerated harness blocks pathspec-scoped.
   `.dreamteamer/` is gitignored, so a fresh checkout has no runtime and `check` would otherwise
   answer "no compiled runtime" for every landing.
4. **`dt check` on the rebased tree.** A failure stops here: `land/<name>` is KEPT for inspection
   and the message says the branch is rebased and NOT landed. (A compile *error* deletes the copy;
   a check *failure* keeps it. Both are safe — the difference is whether there is anything to look
   at.)
5. **Fast-forward**, asked of `git merge-base --is-ancestor` rather than of git's English. If the
   primary moved underneath, the copy is re-rebased and retried, three times, then refused.
6. **`npm ci` in the primary** if the range changed `package-lock.json`, then **compile** there.
7. **Retire** — but only after re-measuring. See the warning below.

⚠ **A worktree that CHANGED during the landing is kept, not destroyed.** Cleanliness is measured
when the landing starts; a session inside that worktree can write a record while the rebase runs.
So the tree is measured again immediately before the destructive step, and if it changed it survives
with its own line: `worktree kept at <path> — it changed during the landing (<n> path(s)); land
again to pick them up`. Exit 0 — the landing itself succeeded. The window is milliseconds, not zero:
**a harness hook must never delete a dirty worktree on its own.**

`--json` carries `kept`, read from the disk after the work rather than inferred from the flags that
went in, so a script can tell a retired worktree from one that survived.

⚠ **`--keep` recompiles the kept worktree, and a compile is a write.** The tree is reset to what
landed and then compiled, so if that compile produces a block even one byte different from the one
just committed, the worktree is left with a modified tracked `CLAUDE.md` — and the NEXT `dt land` of
it refuses with `1 uncommitted change(s)`. That is an ordinary system write, not a fault: commit it
in the worktree, or land without `--keep`.

## the refusals

Each is printed under `✖ cannot land worktrees/<name>:` and each names its own fix:

| it says | it means |
|---|---|
| `it is the primary checkout` | you named the tree you are standing in |
| `it is DETACHED (no branch)` | give it one — the message prints both spellings, including `--branch <name>` |
| `<n> dirty record(s) — dt commit them first` | the worktree has records written but not published |
| `<n> uncommitted change(s)` | ordinary git dirt in the worktree |
| `branch <b> has an upstream (<u>)` | a pushed branch is not rebased; land it by hand |
| `the primary has <n> pending record write(s)` | ⚠ read from the primary's STORE, not from `git status` — a landing would sweep another session's unpublished records into it |
| `the primary has uncommitted changes to <n> file(s) this branch also touches` | resolve them first |
| `another land holds the lock (pid <p>, <age>)` | wait, or remove the lock if that process is gone |
| `nothing to land` | the branch is already on the primary branch |

`--branch <name>` must name the worktree it is applied to, and it never mutates under `--dry-run`
(the plan prints `would switch …` instead).

## the merge policy

On a conflict, every conflicted path is classified and the classes are treated differently:

| class | how it is known | what happens |
|---|---|---|
| **the generated instruction block** | the path is exactly `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, AND every conflict hunk lies entirely between the block's begin/end markers | the primary's block wins, the rebase continues, and the block is regenerated once at the end |
| **anything else** | — | `rebase --abort`; the paths are listed grouped by collection; exit 1; **both trees exactly as they were** |

⚠ **Matched by exact ROOT path, never by basename.** A nested `docs/CLAUDE.md` is a hand-written
file the compiler never regenerates; taking the primary's side of it would silently discard someone's
prose. And a hunk that touches the markers themselves, or lies outside the block, is an ordinary
conflict — the classifier errs toward surfacing.

There is no union merge. An append-only file is not append-only in practice: rows get corrected in
place, and two branches each appending would keep both. A log conflict is an ordinary conflict,
resolved by hand.

The Cursor rules file is a **whole-file generated output** with no block in it, so there is nothing
to take a side of; `init` gitignores `.cursor/` anyway. A workspace that un-ignores it gets an
ordinary conflict there and regenerates the file.

## hooks

A harness can cut a worktree, or start a session in one, and call the engine at that moment. Print
the configuration for this workspace:

```
dt install --print-adapters
```

Three entry points, each reading the harness's JSON payload from **stdin**:

- `dt install --hook` — a session started. Makes this checkout ready and, in a linked worktree,
  ends the board with the line that tells the session how to finish: *this is worktree `<name>` of
  `<primary>`; before you finish, `dt commit` your records and tell the operator to run `dt land
  worktrees/<name>`.*
- `dt add worktrees --hook` — a worktree is being created. Takes the name from the payload, places
  the tree under `.worktrees/<name>`, and prints the path last. It is a FORM: `--path`, `--base` and
  `--temp` are refused with it, rather than accepted and ignored.
- `dt land --hook --dry-run` — a worktree is being removed. Reports whether it would land, and never
  removes anything. `worktree_path` is required in the payload; a path that is not a registered
  worktree is a quiet exit 0, since the harness may have unregistered it already.

⚠ **`--hook` refuses a terminal.** Reading stdin from a TTY blocks forever with no output, which in
a hook is indistinguishable from a hang; so it says `--hook reads the harness's JSON on stdin —
nothing is piped` and exits.

## the shim

⚠ **A hook's shell reads no startup file.** A hook runs as `sh -c` / `bash -c`, and neither reads a
profile — only an interactive or login shell does. So a hook line beginning with `npm` or `npx` can
fail with *command not found* in an environment where the same command works perfectly in the
operator's terminal, and a hook's stderr is nobody's problem. No profile edit can fix this; a profile
is per-machine, per-shell and outside the workspace, which is the opposite of what a committed
adapter needs to be.

The engine therefore ships `bin/dt-hook.sh`, a POSIX shell shim that resolves node absolutely:
`$DREAMTEAMER_NODE`, then `command -v node`, then the highest `~/.nvm/versions/node/*/bin/node`,
then `/opt/homebrew/bin`, then `/usr/local/bin` — and when none resolves it fails LOUDLY onto
stdout, which the harness adds to the session's context, rather than dying silently.

⚠ **Resolving `npm` beside node is not enough.** npm's own shebang is `#!/usr/bin/env node`, so an
absolutely-resolved npm still dies with `env: node: No such file or directory` at exit 127 when the
child's PATH has no node on it. The engine puts node's own directory at the front of the PATH it
hands to any child that needs npm. Measured on a real worktree, not reasoned.

## per harness

Only Claude Code's adapter ships today. The rest are documented as they are measured — the
`SessionStart` contract is the same shim line for all of them, and the two things that stay
per-harness are the **per-directory trust prompt** and **removal**, which only some harnesses hook
at all.

| harness | creation | session start | removal |
|---|---|---|---|
| Claude Code | `WorktreeCreate` — replaces git's own logic; your hook cuts the tree and prints its path | `SessionStart`, no matcher, `cwd` in the payload | `WorktreeRemove` — dry-run only; never delete a dirty worktree from a hook |
| Codex · Gemini CLI · Cursor · pi | not yet shipped | not yet shipped | not hooked, or not documented |

## common mistakes

| mistake | what happens |
|---|---|
| running `dt land` from inside the worktree being landed | works, but the primary is where the verb belongs — it is the tree being changed |
| deleting a worktree with `git worktree remove` | git checks a dirty tree and stops there; it knows nothing about unpublished records or orphaned commits. `dt rm worktrees/<n>` does |
| expecting a sandbox to see uncommitted work | a worktree is cut from HEAD. What is not committed is not there — the engine-ships-first rule in miniature |
| putting `npm` at the front of a hook line | works in a terminal, fails in the hook. Use `dt install --print-adapters` and paste what it gives you |
| landing a pushed branch | refused. Rebasing a branch someone else may have is not the engine's call |
