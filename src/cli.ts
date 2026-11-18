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
  init: async args => (await import("./commands/initCommand.ts")).initCommand(args),
  install: async args => (await import("./commands/installCommand.ts")).installCommand(args),
  update: async args => (await import("./commands/updateCommand.ts")).updateCommand(args),
  compile: async args => (await import("./commands/compileCommand.ts")).compileCommand(args),
  check: async args => (await import("./commands/checkCommand.ts")).checkCommand(args),
  exports: async args => (await import("./commands/exportsCommand.ts")).exportsCommand(args),
  setup: async args => (await import("./commands/setupCommand.ts")).setupCommand(args),
  doctor: async args => (await import("./commands/doctorCommand.ts")).doctorCommand(args),
  changes: async args => (await import("./commands/changesCommand.ts")).changesCommand(args),
  commit: async args => (await import("./commands/commitCommand.ts")).commitCommand(args),
  status: async args => (await import("./commands/statusCommand.ts")).statusCommand(args),
  help: async () => (await import("./commands/helpCommand.ts")).helpCommand(),
  list: async args => (await import("./commands/listCommand.ts")).listCommand(args),
  add: async args => (await import("./commands/addCommand.ts")).addCommand(args),
  values: async args => (await import("./commands/valuesCommand.ts")).valuesCommand(args),
  get: async args => (await import("./commands/getCommand.ts")).getCommand(args),
  set: async args => (await import("./commands/setCommand.ts")).setCommand(args),
  rm: async args => (await import("./commands/rmCommand.ts")).rmCommand(args),
  rename: async args => (await import("./commands/renameCommand.ts")).renameCommand(args),
  history: async args => (await import("./commands/historyCommand.ts")).historyCommand(args),
  diff: async args => (await import("./commands/diffCommand.ts")).diffCommand(args),
  revert: async args => (await import("./commands/revertCommand.ts")).revertCommand(args),
  reorder: async args => (await import("./commands/reorderCommand.ts")).reorderCommand(args),
  next: async args => (await import("./commands/nextCommand.ts")).nextCommand(args),
  "add-field": async args => (await import("./commands/addFieldCommand.ts")).addFieldCommand(args),
  "set-field": async args => (await import("./commands/setFieldCommand.ts")).setFieldCommand(args),
  "rm-field": async args => (await import("./commands/rmFieldCommand.ts")).rmFieldCommand(args),
  "rename-field": async args => (await import("./commands/renameFieldCommand.ts")).renameFieldCommand(args),
  "rename-value": async args => (await import("./commands/renameValueCommand.ts")).renameValueCommand(args),
  relations: async args => (await import("./commands/relationsCommand.ts")).relationsCommand(args),
  relocate: async args => (await import("./commands/relocateCommand.ts")).relocateCommand(args),
  resolve: async args => (await import("./commands/resolveCommand.ts")).resolveCommand(args),
  fmt: async args => (await import("./commands/fmtCommand.ts")).fmtCommand(args),
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
      ? async () => (await import("./commands/versionCommand.ts")).versionCommand()
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
