// ⚠ IMPORTS ARE LAZY, BY DESIGN. Every `dt` launch is a new process, and a static import here is
// paid by every verb: with all commands imported up front, `dt --version` loaded 394 engine modules
// plus ajv and both YAML libraries, ~60% of a launch's wall time. Each verb lives in its own file under
// commands/ and is imported only when it runs, and `openWorkspace` loads the public API only when an
// extension is declared. Keep the static imports to what EVERY path needs.
import { openWorkspace } from "./openWorkspace.ts"

/**
 * Flags consumed BEFORE dispatch, in bin/dreamteamer.js, so no verb ever sees them. They are real
 * and honoured; they are simply honoured earlier than VERB_FLAGS/WORKSPACE_FLAGS can express.
 *
 * ⚠ Listing one here EXEMPTS it from the "documented flags are accepted by some verb" guard, which
 * exists because 0.19.0 shipped a flag that was documented and silently swallowed. The exemption is
 * only safe while the behaviour is pinned somewhere else: `--workspace` / `-w` is covered end-to-end in
 * test/integration/workspace-flag.test.js and `--vault` in cross-workspace-targeting.test.js. A global
 * flag with no such file is the exact defect that guard was written to catch \u2014 add the coverage,
 * not the entry.
 */
export const GLOBAL_FLAGS = ["workspace", "vault"]

/**
 * WORKSPACE VERBS take a closed set of options, and nothing downstream of here would notice a
 * misspelling — `dt commit --dryrun` COMMITTED, because `rest.includes('--dry-run')` is false for a
 * flag nobody typed correctly. The record/system/field verbs are checked by `lib/refuseUnknownFlags.ts`
 * against VERB_FLAGS, beside the parser they share; these have no shared parser, so the table is here.
 */
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

/** A core verb: its exit code — or nothing, when the process must stay alive (`compile --watch`).
 *  Each command opens the workspace itself, so `init`, `help`, `version` and `check --alone` can
 *  answer without one. */
type Command = (args: string[]) => Promise<number | void>

/** Every core verb, one file each. Each entry imports its file lazily and calls that module's own
 *  function, so the call is statically resolved and `layers` sees the edge. */
const COMMANDS: Record<string, Command> = {
  init: async args => (await import("./commands/init.ts")).run(args),
  install: async args => (await import("./commands/install.ts")).run(args),
  update: async args => (await import("./commands/update.ts")).run(args),
  compile: async args => (await import("./commands/compile.ts")).run(args),
  check: async args => (await import("./commands/check.ts")).run(args),
  exports: async args => (await import("./commands/exports.ts")).run(args),
  setup: async args => (await import("./commands/setup.ts")).run(args),
  doctor: async args => (await import("./commands/doctor.ts")).run(args),
  changes: async args => (await import("./commands/changes.ts")).run(args),
  commit: async args => (await import("./commands/commit.ts")).run(args),
  status: async args => (await import("./commands/status.ts")).run(args),
  help: async () => (await import("./commands/help.ts")).run(),
  list: async args => (await import("./commands/list.ts")).run(args),
  add: async args => (await import("./commands/add.ts")).run(args),
  values: async args => (await import("./commands/values.ts")).run(args),
  get: async args => (await import("./commands/get.ts")).run(args),
  set: async args => (await import("./commands/set.ts")).run(args),
  rm: async args => (await import("./commands/rm.ts")).run(args),
  rename: async args => (await import("./commands/rename.ts")).run(args),
  history: async args => (await import("./commands/history.ts")).run(args),
  diff: async args => (await import("./commands/diff.ts")).run(args),
  revert: async args => (await import("./commands/revert.ts")).run(args),
  reorder: async args => (await import("./commands/reorder.ts")).run(args),
  next: async args => (await import("./commands/next.ts")).run(args),
  "add-field": async args => (await import("./commands/add-field.ts")).run(args),
  "set-field": async args => (await import("./commands/set-field.ts")).run(args),
  "rm-field": async args => (await import("./commands/rm-field.ts")).run(args),
  "rename-field": async args => (await import("./commands/rename-field.ts")).run(args),
  "rename-value": async args => (await import("./commands/rename-value.ts")).run(args),
  relations: async args => (await import("./commands/relations.ts")).run(args),
  relocate: async args => (await import("./commands/relocate.ts")).run(args),
  resolve: async args => (await import("./commands/resolve.ts")).run(args),
  fmt: async args => (await import("./commands/fmt.ts")).run(args),
}
/** The spellings of `version` — not verbs of the grammar, so not in COMMANDS. */
const VERSION = new Set(["version", "--version", "-v"])

export async function run(argv: string[]): Promise<void> {
  const [cmd = "help", ...rest] = argv
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
    const command: Command | undefined = VERSION.has(cmd)
      ? async () => (await import("./commands/version.ts")).run()
      : COMMANDS[cmd]
    if (command) {
      const code = await command(rest)
      if (typeof code === "number") process.exit(code)
      return
    }
    // An EXTENSION'S VERB runs in-process, handed this workspace — the same engine instance, the
    // same loaded extensions. Its exit code is the process's. (A core verb never gets here: core
    // reserves CORE_VERBS, so no extension can claim one.)
    const ws = await openWorkspace()
    const ext = ws.extensions.find(e => cmd in e.commands)
    if (ext) {
      const code = await ext.commands[cmd].run(ws, rest)
      process.exit(typeof code === "number" ? code : 0)
    }
    const { unknownVerb } = await import("./commands/lib/unknownVerb.ts")
    process.exit(unknownVerb(cmd))
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
