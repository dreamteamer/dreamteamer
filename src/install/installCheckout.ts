import path from "node:path"
import { applyInstall } from "./applyInstall.ts"
import { observeState } from "./observeState.ts"
import { planInstall } from "./planInstall.ts"
import { readHookInput } from "./readHookInput.ts"
import { readStdin } from "./readStdin.ts"
import type { LoadedExtension, Workspace } from "../types.ts"

// The hook events and the verb each one runs. Core owns ONE — making the checkout a session opens in
// ready — and an installed extension adds its own (`hooks:` in its contribution; the worktree
// lifecycle belongs to a worktree extension). NO MATCHER on any of them (spec §13.9): bootstrap is
// idempotent precisely so the session-start hook may fire on every event — `startup` alone would
// silence it on resume, clear, compact and fork, which is most of what a long session actually does.
const CLAUDE_HOOKS: Record<string, string> = { SessionStart: "install --hook" }

/** Print the harness snippets for this workspace's declared harnesses.
 *
 *  ⚠ NO ABSOLUTE MACHINE PATH IS EVER RENDERED, and the command is `sh <script>` rather than a bare
 *  `npm`/`npx`/`node` — the two constraints that between them decide every character of the line.
 *  `$CLAUDE_PROJECT_DIR` is documented to stay at the MAIN checkout even inside a worktree, which is
 *  exactly the engine wanted: the primary's pinned one, never whatever a fresh worktree lacks. The
 *  worktree's own cwd arrives in the hook's stdin instead.
 *
 *  ⚠ AND THE ENGINE NEVER WRITES A HARNESS SETTINGS FILE. `.claude/settings.json` is the operator's,
 *  reviewed like any config change; a fifth harness channel writing into a user-owned file is a
 *  decision this engine has not made (spec §13.7). So this verb PRINTS — snippets on stdout, so the
 *  output can be piped, and everything else on stderr so it stays parseable. */
function printAdapters(
  ws: Workspace,
  {
    harnesses = ws.pkg.dreamteamer?.harnesses ?? ["claude-code"],
    extensions = ws.extensions ?? [],
  }: { harnesses?: string[]; extensions?: LoadedExtension[] } = {}
): number {
  // ⚠ AN EMPTY RENDER IS A REFUSAL, NOT A SUCCESS. The whole point of this verb is that its stdout
  // is redirected into a settings file — so printing nothing at exit 0 writes an EMPTY hooks.json
  // over whatever was there, silently, on the one workspace that never declared the harness.
  if (!harnesses.includes("claude-code")) {
    console.error("no claude-code harness declared — nothing to render")
    return 1
  }
  for (const h of harnesses) {
    // `claude-code` is the ONLY spelling: it is what KNOWN_HARNESSES holds and what every real
    // package.json carries. The design doc's shorter `claude` names no harness this engine
    // compiles for, so accepting it would only ever mask a misspelling.
    if (h !== "claude-code") {
      console.error(`${h}: adapter not yet shipped (decision 315)`)
      continue
    }
    const hooks: Record<string, unknown[]> = {}
    const events: Record<string, string> = { ...CLAUDE_HOOKS }
    for (const e of extensions) {
      for (const [event, verb] of Object.entries(e.hooks ?? {})) {
        if (events[event])
          throw new Error(
            `extension ${e.name} and ${Object.keys(CLAUDE_HOOKS).includes(event) ? "the engine" : "another extension"} both hook ${event} — uninstall or disable one`
          )
        events[event] = verb
      }
    }
    for (const [event, verb] of Object.entries(events)) {
      hooks[event] = [
        {
          hooks: [
            {
              type: "command",
              command: `sh "$CLAUDE_PROJECT_DIR/node_modules/dreamteamer/bin/dt-hook.sh" ${verb}`,
              timeout: 600,
            },
          ],
        },
      ]
    }
    console.error("# merge into .claude/settings.json — writing it is the operator's act, never the engine's")
    console.log(JSON.stringify({ hooks }, null, 2))
  }
  return 0
}

/** `dt install` on THIS checkout.
 *
 *  ⚠ `--json` IS NOT A DRY RUN: it applies the plan and then reports it as data. Which means the
 *  run that most needs to be parseable — the FIRST install in a fresh worktree — is also the one
 *  with the most to say: `compile` logs its summary through console.log, and the shelled-out steps
 *  write to whatever handles they inherit. So under `--json` stdout carries the payload and
 *  NOTHING else: the board goes to stderr (a human watching a piped run still wants it),
 *  console.log is pointed at stderr for the duration, and each subprocess is handed stderr for its
 *  own stdout. A `--json` that only parses on an already-settled checkout is not an interface. */
export async function installCheckout(
  ws: Workspace,
  rest: string[],
  { open }: { open?: (at: string) => Promise<Workspace> } = {}
): Promise<number> {
  // ⚠ THE OPENER IS REQUIRED, and it must ACTIVATE extensions: the compile step reopens with it (see
  // applyInstall), so a raw `findWorkspace` default compiled an extension's kind as an unknown folder.
  // The public export (api.js) supplies `openWorkspace`; this layer cannot import it.
  if (typeof open !== "function")
    throw new Error("installCheckout: opts.open (an extension-activating opener, e.g. openWorkspace) is required")
  const flags = new Set(rest.filter(a => a.startsWith("--")))
  if (flags.has("--print-adapters")) return printAdapters(ws, {})
  const hook = flags.has("--hook")
  // ⚠ NEVER `process.chdir`. The hook runs in the PRIMARY (that is what $CLAUDE_PROJECT_DIR
  // resolves to, worktree or not), and the checkout it is about is the one named on stdin — so the
  // workspace is rebuilt from that path and everything downstream is unchanged. Installing
  // `process.cwd()` instead would print a green board about the wrong checkout on every spawn.
  if (hook) {
    const input = readHookInput(readStdin())
    if (!input.cwd) throw new Error(`hook input carries no cwd — keys received: ${Object.keys(input.raw).join(", ")}`)
    // the checkout the payload names, opened the way the caller opens one (the CLI passes
    // `openWorkspace`, so ITS extensions load — their hooks and kinds are part of that checkout)
    ws = await open(input.cwd)
  }
  const json = flags.has("--json")
  const state = observeState(ws)
  const steps = planInstall(state, { linkEnv: flags.has("--link-env") })
  const board: string[] = []
  const log = (l: string): void => {
    board.push(l)
    ;(json ? console.error : console.log)(l)
  }
  log(
    state.checkout.kind === "linked"
      ? `linked worktree of ${state.checkout.primary}${state.checkout.insideRoot ? "" : " (outside its root)"}`
      : "primary checkout"
  )
  const stdout = console.log
  if (json) console.log = console.error // compile() and the git-modules restore report through it
  let code: number
  try {
    code = await applyInstall(ws, state, steps, {
      dryRun: flags.has("--dry-run"),
      log,
      stdio: json ? ["ignore", 2, 2] : "inherit",
      open,
    })
  } finally {
    console.log = stdout
  }
  if (json) {
    console.log(JSON.stringify({ checkout: state.checkout, steps, log: board, code }, null, 2))
    return code
  }
  // ⚠ THE BOARD IS THE SESSION'S CONTEXT when a session-start hook runs it, so its LAST line says
  // the one thing a session in a linked worktree cannot work out for itself: its records are
  // invisible from the primary until they are committed here.
  if (state.checkout.kind === "linked") {
    log(
      `\nthis is linked worktree ${path.basename(ws.root)} of ${state.checkout.primary}; before you finish, dt commit your records here — they are invisible from the primary until you do.`
    )
  }
  return code
}
