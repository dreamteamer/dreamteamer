# module scripts — capability without a core verb

A module can ship RUNNABLE CODE: a script in a skill folder (`modules/<m>/skills/<name>/find.mjs`
— extra files travel with the folder, see `skills.md`) that imports the engine and does something
no collection, command or ui-view can express. This is the escape valve: a capability that wants
engine access and a CLI-shaped invocation, but has not earned a place in core, lives here — proves
itself here — and only then argues for promotion.

## loading the engine

```js
import { findWorkspace } from 'dreamteamer/src/workspace.js';
import { Store } from 'dreamteamer/src/store.js';
const ws = findWorkspace();          // walks up from cwd, same as the CLI
const store = new Store(ws);         // validated reads/writes, ref checks, commit shape — free
```

`'dreamteamer'` resolves against the WORKSPACE's own `node_modules`/`git_modules` — the pinned
engine, the same one `dt` runs (decision 24's self-shadowing, working for you here: script and
engine version travel together). There is deliberately NO stable plugin API: a module script is
workspace-local code with no version discipline to honour, exactly like a copied recipes
collection. When the engine moves and a deep import breaks, it breaks LOUDLY in the one workspace
that owns the script, and whoever runs the session fixes their copy.

## the rules that keep this safe

- **Explicit invocation only.** A script runs when a person or an agent names it — never from a
  compile step, a store hook, or anything `dt` does implicitly. A module is a folder someone
  copied; code that runs on copy is an attack, not a capability.
- **Writes go through the Store** (or schema-ops). A script that hand-writes `data/` forfeits
  validation, ref rewrites and the one-commit shape — the same rule the extension lives under.
- **Derived state is dot-prefixed and gitignored** (`.cache/` beside the script, skill-local
  `.gitignore` — the convention `skills.md` documents). Never authoritative, always rebuildable.
- **Reference the SOURCE path** in the skill body (`node modules/<m>/skills/<name>/find.mjs`),
  never `.claude/skills/…` — that copy is wiped every compile.

## discoverability: the skill IS the registry

There is no verb registration, on purpose — a `dt` that dispatches into module code would give
every borderline capability a home and every copied module a hook. The skill's `description` is
what a session scans; a well-written trigger does for an agent what `--help` does for a person.

## promotion — or deletion

Instrument the script (count invocations into its `.cache/`). The workflow layer and `dt migrate`
were both correct, gate-tested and unused — measure before you keep. A script that earns real
usage AND wants an extension button is the promotion signal: land the engine function plus the
CLI verb in core, then wire the gesture. A script nobody ran answers the question too.

A worked example ships with the engine: `examples/modules/search/` — hybrid full-text search over
every record, FTS5 via node:sqlite, zero dependencies, usage-logged.
