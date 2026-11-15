// ⚠ IMPORTS ARE LAZY, BY DESIGN. Every `dt` launch is a new process, and a static import here is
// paid by every verb: with all commands imported up front, `dt --version` loaded 394 engine modules
// plus ajv and both YAML libraries, ~60% of a launch's wall time. Each verb now imports its own command
// when it runs, and `openWorkspace` loads the public API only when an extension is declared.
// Keep the static imports to what EVERY path needs.
import fs from "node:fs"
import path from "node:path"
import { emit } from "./lib/emit.ts"
import { findWorkspace } from "./workspace/findWorkspace.ts"
import { openWorkspace } from "./openWorkspace.ts"
import type { Flags, Workspace } from "./types.ts"
import { USAGE } from "./usage.ts"

// Record verbs, split by what their <target> means. `move` and `next` are in NEITHER set: both
// accept either shape, and which one it is has to be decided against the declared collections.
// How many rows a per-record listing prints before it summarises. ONE number, because a report that
// caps one of its lists and not the next reads as a bug in whichever list ran long.

const REF_VERBS = new Set(["get", "set", "rm", "rename", "history", "diff", "revert"])
const COLLECTION_VERBS = new Set(["list", "add", "values"])

// FIELD VERBS (add-field, set-field, rm-field, rename-field, rename-value). Their <target> is a collection and everything else is flags, which is the one shape
// that differs from the record verbs — so they get their own case arm rather than being folded into
// `dispatchRecordVerb`. There is no `schema <op>` table any more: system entities take the record
// verbs, and `targetCommand`'s interceptors are the whole dispatch (§4).

// WORKSPACE VERBS take a closed set of options, and nothing downstream of here would notice a
// misspelling — `dt commit --dryrun` COMMITTED, because `rest.includes('--dry-run')` is false for a
// flag nobody typed correctly. The record/system/field verbs are checked in `collections-cli.js`,
// beside the parser they share; these nine have no shared parser, so the table is here.
// Flags consumed BEFORE dispatch, in bin/dreamteamer.js, so no verb ever sees them. They are real
// and honoured; they are simply honoured earlier than VERB_FLAGS/WORKSPACE_FLAGS can express.
//
// ⚠ Listing one here EXEMPTS it from the "documented flags are accepted by some verb" guard, which
// exists because 0.19.0 shipped a flag that was documented and silently swallowed. The exemption is
// only safe while the behaviour is pinned somewhere else: `--workspace` / `-w` is covered end-to-end in
// test/integration/workspace-flag.test.js and `--vault` in cross-workspace-targeting.test.js. A global
// flag with no such file is the exact defect that guard was written to catch \u2014 add the coverage,
// not the entry.
export const GLOBAL_FLAGS = ["workspace", "vault"]

export const WORKSPACE_FLAGS: Record<string, string[]> = {
  init: [
    "name",
    "data_path",
    "harnesses",
    "workspace_module",
    "no-git",
    "git",
    "no-compile",
    "from",
    "input",
    "allow",
    "no-input",
  ],
  update: ["engine", "allow", "from", "no-commit"],
  install: [
    "clone",
    "dry-run",
    "json",
    "link-env",
    "all",
    "hook",
    "print-adapters",
    "from",
    "input",
    "allow",
    "no-input",
    "no-commit",
  ],
  compile: ["watch"],
  check: ["strict-export", "alone", "keep"],
  exports: ["layer", "dry-run", "json"],
  status: ["json"],
  doctor: ["strict", "json"],
  setup: ["input", "allow", "authorize", "verify", "skip", "no-input", "json"],
  changes: ["since", "json"],
  commit: ["dry-run", "json"],
  fmt: ["dry-run"],
  relocate: ["dry-run", "json", "to-root"],
}

export { CORE_VERBS } from "./coreVerbs.ts"

/** Verbs an extension answers, and the package it ships in — typed without it, the verb prints the
 *  install line. The container verbs belong to the global `dt-docker` bin, which needs no workspace. */
const VERB_PACKAGES: Record<string, string> = {
  prove: "@dreamteamer/proofs",
  land: "@dreamteamer/worktrees",
  worktree: "@dreamteamer/worktrees",
  serve: "@dreamteamer/web",
  web: "@dreamteamer/web",
  notebooklm: "@dreamteamer/notebooklm",
}
const DOCKER_VERBS = new Set(["start", "stop", "open", "export", "import"])

/** `dt check` on a workspace with its extensions' own violations — what init and install verify with. */
const verify = async (ws: Workspace): Promise<number> => {
  const [{ check }, api] = await Promise.all([import("./check/check.ts"), import("./api.ts")])
  return check(ws, { extra: await api.contributedViolations(ws) })
}

export async function run(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  try {
    if (cmd in WORKSPACE_FLAGS) {
      const bad = rest
        .filter(a => a.startsWith("--"))
        .map(a => a.slice(2).split("=")[0])
        .find(f => !WORKSPACE_FLAGS[cmd].includes(f))
      if (bad)
        throw new Error(
          `unknown flag "--${bad}" on \`dt ${cmd}\`\n  known: ${WORKSPACE_FLAGS[cmd].map(f => `--${f}`).join(", ") || "(none — this verb takes no flags)"}`
        )
    }
    if (cmd === "--version" || cmd === "-v" || cmd === "version") {
      // works OUTSIDE a workspace — the post-install "did it land?" affordance
      const p = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
      console.log(`${p.name}@${p.version}`)
      process.exit(0)
    }
    if (cmd === "init") {
      // init runs BEFORE a workspace exists — no findWorkspace
      const flags: Flags = {}
      for (let i = 0; i < rest.length; i++)
        if (rest[i].startsWith("--")) {
          const [k, v] = rest[i].slice(2).split(/=(.*)/s)
          flags[k] = v ?? rest[i + 1]
        }
      // boolean flags take no value: a following positional is not theirs
      for (const b of ["no-git", "no-compile", "no-input"]) if (b in flags) flags[b] = true
      const { initCommand } = await import("./init/initCommand.ts")
      process.exit(
        await initCommand(flags, {
          open: openWorkspace,
          argv: rest,
          verify,
        })
      )
    }
    if (!cmd || cmd === "help") {
      // `help` works OUTSIDE a workspace too — a person who just ran `npm i -g dreamteamer` on a
      // bare machine has nothing else to read. Inside one, each installed extension's own usage
      // follows the engine's.
      let ws = null
      try {
        ws = await openWorkspace()
      } catch {
        /* no workspace, or an extension that will not load — plain help */
      }
      emit(USAGE + extensionUsage(ws))
      process.exit(0)
    }
    // `dt check modules/<id> --alone` judges one inline module in a fresh workspace (src/check-alone.ts) —
    // dispatched before the host is opened, because the module's own problem (a missing dependency, a
    // floor above this engine) would otherwise surface as the host's refusal instead of the gate's verdict
    if (cmd === "check") {
      const target = rest.find(a => !a.startsWith("--"))
      if (rest.includes("--alone")) {
        const { checkAlone } = await import("./check/checkAlone.ts")
        process.exit(checkAlone(findWorkspace(), { target, keep: rest.includes("--keep") }))
      }
      if (target) {
        console.error(
          `✖ check takes no target — did you mean --alone? (dt check ${target} --alone judges one inline module)`
        )
        process.exit(2)
      }
    }
    let ws
    try {
      ws = await openWorkspace()
    } catch (e) {
      // `status` is read-only and always answers: a runtime whose extensions refuse to load (two
      // packages claiming one unit, a bad declaration) is reported as the status, exit 0
      if (cmd === "status") {
        console.log(`✖ extensions did not load — ${String(e.message).split("\n")[0]}`)
        console.log(
          "  the setup section cannot be read until that is fixed; records and the compiled runtime are untouched"
        )
        process.exit(0)
      }
      throw e
    }
    // An EXTENSION'S VERB runs in-process, handed this workspace — the same engine instance, the
    // same loaded extensions. Its exit code is the process's.
    const ext = ws.extensions.find(e => cmd in e.commands)
    if (ext) {
      const code = await ext.commands[cmd].run(ws, rest)
      process.exit(typeof code === "number" ? code : 0)
    }
    switch (cmd) {
      case "install": {
        const [{ installCommand }, { targetCommand }] = await Promise.all([
          import("./install/installCommand.ts"),
          import("./targetCommand.ts"),
        ])
        return process.exit(
          await installCommand(ws, rest, {
            open: openWorkspace,
            verify,
            ensureRepos: args => targetCommand(ws, "repos", "ensure", args),
          })
        )
      }
      case "update": {
        const { updateCommand } = await import("./update/updateCommand.ts")
        return process.exit(await updateCommand(ws, rest, { open: openWorkspace }))
      }
      case "compile": {
        const compiler = await import("./compile/compile.ts")
        const code = compiler.compile(ws)
        if (!rest.includes("--watch")) process.exit(code)
        console.log("… watching sources (modules/*, git_modules/*, and the workspace root) — ctrl-c to stop")
        watchAndRecompile(ws, compiler)
        return
      }
      case "check": {
        const [{ check }, { warnIfStale }] = await Promise.all([
          import("./check/check.ts"),
          import("./compile/warnIfStale.ts"),
        ])
        const extra = warnIfStale(ws.root).compiled ? await (await import("./api.ts")).contributedViolations(ws) : []
        return process.exit(check(ws, { extra, strictExport: rest.includes("--strict-export") }))
      }
      case "exports": {
        const [{ runExports }, { Store }] = await Promise.all([
          import("./exports/runExports.ts"),
          import("./store/Store.ts"),
        ])
        const layers = rest
          .flatMap((a, i) => (a === "--layer" ? [rest[i + 1]] : a.startsWith("--layer=") ? [a.slice(8)] : []))
          .filter(Boolean)
        return process.exit(
          runExports(new Store(ws), { layers, dryRun: rest.includes("--dry-run"), json: rest.includes("--json") })
        )
      }
      // `dt setup [<unit>] …` — the generic driver of the units installed modules declare (src/setup.js):
      // inputs, consent per effect, inspect → plan → apply, the receipt. The engine names no module.
      case "setup": {
        const [{ setupCommand }, api] = await Promise.all([import("./setup/setupCommand.ts"), import("./api.ts")])
        return process.exit(await setupCommand(ws, rest, { api }))
      }
      case "doctor": {
        const [{ doctorCommand }, api] = await Promise.all([import("./doctor/doctorCommand.ts"), import("./api.ts")])
        return process.exit(await doctorCommand(ws, rest, api))
      }
      case "changes": {
        const { changesCommand } = await import("./changes/changesCommand.ts")
        return process.exit(changesCommand(ws, rest))
      }
      case "commit": {
        const { commitCommand } = await import("./commitCommand.ts")
        return process.exit(commitCommand(ws, rest))
      }
      case "status": {
        const { statusCommand } = await import("./statusCommand.ts")
        return process.exit(statusCommand(ws, rest))
      }
      case "help":
        emit(USAGE)
        return process.exit(0)
      case "list":
      case "add":
      case "values":
      case "get":
      case "set":
      case "rm":
      case "rename":
      case "history":
      case "diff":
      case "revert":
      case "reorder":
      case "next": {
        const { warnIfStale } = await import("./compile/warnIfStale.ts")
        warnIfStale(ws.root)
        return process.exit(await dispatchRecordVerb(ws, cmd, rest))
      }
      // The verb `check`'s stale-mirror message names. It reads the compiled relations, and
      // rebuild WRITES records, so both want the same staleness warning every record verb gets.
      // FIELD VERBS — see the note beside REF_VERBS at the top of this file. Their <target> is a collection and everything else is
      // flags, so they are their own case rather than being folded into `dispatchRecordVerb`.
      //
      // ⚠ THE RETIRED SPELLINGS ARE GONE, not aliased. The 0.12.0 policy: a stale invocation
      // must fail loudly, because a half-working grammar teaches the wrong shape without ever
      // saying so. The `default` arm below names each one — `schema`, `ensure`, `update-field`,
      // `remove-field`, `commands` — and carries its replacement.
      case "add-field":
      case "set-field":
      case "rm-field":
      case "rename-field":
      case "rename-value": {
        const [{ warnIfStale }, { targetCommand }, { Store }, { canonicalCollection }] = await Promise.all([
          import("./compile/warnIfStale.ts"),
          import("./targetCommand.ts"),
          import("./store/Store.ts"),
          import("./record/ref.ts"),
        ])
        warnIfStale(ws.root)
        const [target, ...flagArgs] = rest
        if (!target || target.startsWith("--")) {
          throw new Error(`dt ${cmd} needs a collection: dreamteamer ${cmd} <collection> --name <field> …`)
        }
        // the singular is legal here too: `dt add-field task --name due …`
        return process.exit(
          await targetCommand(ws, canonicalCollection(new Store(ws).descriptors, target) ?? target, cmd, flagArgs)
        )
      }
      case "relations": {
        const [{ warnIfStale }, { relationsCommand }] = await Promise.all([
          import("./compile/warnIfStale.ts"),
          import("./relationsCommand.ts"),
        ])
        warnIfStale(ws.root)
        return process.exit(relationsCommand(ws, rest))
      }
      case "relocate": {
        const { relocateCommand } = await import("./relocateCommand.ts")
        return process.exit(relocateCommand(ws, rest))
      }
      case "resolve": {
        const { resolveCommand } = await import("./resolveCommand.ts")
        return process.exit(resolveCommand(ws, rest))
      }
      case "fmt": {
        const { fmtCommand } = await import("./fmt/fmtCommand.ts")
        return process.exit(fmtCommand(ws, rest))
      }
      default:
        // ⚠ NAMED, not just unknown. Every doc, skill and downstream script spelled these
        // `dt schema <op>` for seven releases, so the failure has to carry the translation —
        // an "unknown verb" alone sends the reader to `help` to guess which of thirty verbs
        // replaced the one they typed. No alias layer and no deprecation window: 0.12.0's
        // policy, and the reason it is the right one is that `dt contacts list` failing
        // loudly is what taught the verb-first grammar in one command.
        //
        // ⚠ ONE EXIT CODE FOR ALL OF THEM: 2, the usage code. "You typed a verb that is
        // gone" is one answer, so a script (and an operator) asks it once rather than
        // learning which retirement exits 1 and which exits 2.
        if (cmd === "schema") {
          console.error(
            '✖ unknown verb "schema" — schema verbs are gone since 0.19.0. System entities take the RECORD verbs now:'
          )
          console.error(
            "    dt add collections --name <c> [--module <m>] · dt rm collections/<c> · dt rename collections/<old> <new>"
          )
          console.error(
            "    dt set collections/<c> module=<m> | <scalar>=<v>   · dt get collections/<c> [--module <m>]"
          )
          console.error(
            "    dt add-field <c> … · dt set-field <c> … · dt rm-field <c> … · dt rename-field <c> --name <f> --to <g>"
          )
          console.error("    dt add|set|rm|rename modules/<id> …               · dt add|set|rm|rename ui-views/<id> …")
          console.error(
            "  the full mapping table is in UPDATING.md (0.18.0 → 0.19.0), and `dt help` has the current spellings."
          )
          process.exit(2)
        }
        if (cmd === "ensure") {
          console.error(
            '✖ unknown verb "ensure" — gone since 0.22.0 (decision 309: install is the one verb that makes a thing present and ready):'
          )
          console.error(
            "    dt install                 this checkout — engine, .env, local assets, git modules, compile, postinstall"
          )
          console.error("    dt install repos/<id>      materialize one attached repo · dt install repos --all")
          process.exit(2)
        }
        // The change verbs spell one way. `add · set · rm · rename` are the record verbs, so
        // `update-field`/`remove-field` were a second spelling for one action inside one
        // grammar — the field verbs now say `add-field · set-field · rm-field · rename-field`.
        if (cmd === "update-field" || cmd === "remove-field") {
          const to = cmd === "update-field" ? "set-field" : "rm-field"
          console.error(
            `✖ unknown verb "${cmd}" — gone since 0.22.0 (decision 309: a field verb spells its action the way the record verbs do):`
          )
          console.error(`    dt ${to} <collection> --name <field> …`)
          console.error("    the field verbs are: dt add-field · dt set-field · dt rm-field · dt rename-field")
          process.exit(2)
        }
        // `dt commands <ref>` and `dt list commands` were one word for two things — the read
        // verb and the system entity. `next` also says what it answers.
        if (cmd === "commands") {
          console.error(
            '✖ unknown verb "commands" — gone since 0.22.0 (decision 309: it collided with the `commands` ENTITY, which `dt list commands` reads):'
          )
          console.error(
            "    dt next <collection>[/<id>]   which bound commands apply to this record, and in which state"
          )
          console.error("    dt list commands              the command entities this workspace ships")
          process.exit(2)
        }
        if (VERB_PACKAGES[cmd]) {
          console.error(
            `✖ \`dt ${cmd}\` comes from an extension this workspace does not have — install it:\n    dt install ${VERB_PACKAGES[cmd]}`
          )
          process.exit(2)
        }
        if (DOCKER_VERBS.has(cmd)) {
          console.error(
            `✖ \`dt ${cmd}\` is not a workspace verb — containers are managed by dt-docker:\n    npm i -g @dreamteamer/docker-workspaces\n    dt-docker ${cmd} container <name>`
          )
          process.exit(2)
        }
        console.error(`✖ unknown verb "${cmd}" — the verb comes first: dt <verb> [<target>]`)
        emit(USAGE, 2)
        process.exit(1)
    }
  } catch (e) {
    console.error(`✖ ${e.message}`)
    // ⚠ AND ON STDOUT UNDER `--hook`, because that is the whole reason the shim exists.
    // `bin/dt-hook.sh` fails onto stdout with a comment saying why: a hook's stdout is added to
    // the session's context and its stderr is nobody's problem. Every success path here already
    // prints to stdout; every FAILURE went to stderr alone, so a mis-wired hook, a bad payload, a
    // TTY invocation or a refusal was invisible to exactly the reader the shim was built for.
    if (process.argv.includes("--hook")) console.log(`✖ ${e.message}`)
    process.exit(1)
  }
}

/** Each installed extension's usage block, headed by its package — '' outside a workspace. */
function extensionUsage(ws: Workspace | null) {
  const blocks = (ws?.extensions ?? [])
    .filter(e => Object.keys(e.commands).length)
    .map(
      e =>
        `\n${e.name}@${e.version}:\n${Object.entries(e.commands)
          .map(([verb, c]) => (c.usage ?? `  ${verb}`).replace(/\s+$/, ""))
          .join("\n")}`
    )
  return blocks.length ? `\ninstalled extensions:${blocks.join("\n")}` : ""
}

/** Translate `dt <verb> <target> …` into the noun-verb call the implementation layer takes. */
async function dispatchRecordVerb(ws: Workspace, verb: string, args: string[]): Promise<number> {
  const [{ targetCommand }, { Store }, { canonicalCollection }, { splitRef }] = await Promise.all([
    import("./targetCommand.ts"),
    import("./store/Store.ts"),
    import("./record/ref.ts"),
    import("./record/splitRef.ts"),
  ])
  const [target, ...rest] = args
  if (!target) throw new Error(`dt ${verb} needs a target — see \`dreamteamer help\``)
  // A flag in the target slot is a word-order mistake, not a collection: without this,
  // `dt list --json contacts` reported `unknown collection "--json"` and dumped every name.
  if (target.startsWith("--"))
    throw new Error(`dt ${verb} takes its target BEFORE the flags: dreamteamer ${verb} <target> ${target} …`)
  // A collection may be named by its declared name OR its singular (`dt add task …`); the
  // canonical name is what every layer below sees. An unknown word passes through unchanged so
  // the store's own "unknown collection" sentence, which lists what exists, is the one printed.
  const { descriptors } = new Store(ws)
  const canonical = canonicalCollection(descriptors, target) ?? target
  if (COLLECTION_VERBS.has(verb)) return targetCommand(ws, canonical, verb, rest)
  if (REF_VERBS.has(verb)) {
    const { collection, id } = splitRef(descriptors, target)
    return targetCommand(ws, collection, verb, [id, ...rest])
  }
  // the verbs that take EITHER (`reorder`, `next`) from here: a bare collection is legal for both — `move <collection> --init`,
  // `next <collection>`.
  if (descriptors.has(canonical)) {
    return verb === "reorder"
      ? targetCommand(ws, canonical, "reorder", rest)
      : targetCommand(ws, "commands", "for", [canonical, ...rest])
  }
  const { collection, id } = splitRef(descriptors, target)
  if (verb === "reorder") return targetCommand(ws, collection, "reorder", [id, ...rest])
  // `commands for <c>/<id>` split its own target at the FIRST slash, which cannot name a
  // namespaced collection. splitRef can, so the id is handed over as `--ids` — the same
  // `commandsFor(store, collection, ids)` call, reached without re-encoding the reference.
  // An explicit `--ids` from the caller still wins — by NOT injecting ours, not by ordering. It
  // used to rely on "last flag parsed wins", which stopped being true when a repeated flag started
  // promoting to an array instead of overwriting: the pair would now be refused as a double.
  const ours = rest.some(a => a === "--ids" || a.startsWith("--ids=")) ? [] : ["--ids", id]
  return targetCommand(ws, "commands", "for", [collection, ...ours, ...rest])
}

function watchAndRecompile(ws: Workspace, { compile, kindsOf }: typeof import("./compile/compile.ts")): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const trigger = (_: unknown, file: string | Buffer | null): void => {
    if (file && /^\./.test(String(file))) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        compile(ws)
      } catch (e) {
        console.error(`✖ ${e.message}`)
      }
    }, 200)
  }
  // 'system' plus the flat kinds: the classic layout can put sources at the workspace root under
  // either spelling, and a watcher that misses one makes --watch quietly stop recompiling.
  for (const dir of ["system", ...kindsOf(ws), "modules", "git_modules"].map(d => path.join(ws.root, d))) {
    if (fs.existsSync(dir)) fs.watch(dir, { recursive: true }, trigger)
  }
}
