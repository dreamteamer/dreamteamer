#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// `--workspace <path>` / `-w` — run the verb in ANOTHER workspace without leaving this one
// (`--vault <path>` is its pre-0.41.0 spelling, kept as a silent alias). Consumed HERE, before
// anything else resolves, because every verb downstream answers "which workspace am I in" from
// process.cwd(): changing the directory once IS the whole implementation.
//
// The PATH resolves against the INVOKING directory, which is where the caller typed it; every other
// relative path in the command then resolves against the target — the rule a `cd` would give. The
// target is PINNED for this process only: a workspace nested under another's modules/ is otherwise
// climbed out of by discovery, which would run the verb in the workspace AROUND it.
// `--workspace=<x>` (npm's spelling too) is the same flag in one argument.
//
// The scan stops where `dt run <module> <script>` hands its arguments to the script: those are the
// script's, and a `-w` among them is its own flag, never this CLI's workspace.
const GLOBAL_FLAG = /^(--workspace|-w|--vault)(=|$)/
const scanEnd = passThroughAt(process.argv)
const flagAt = process.argv.findIndex((a, i) => i >= 2 && i < scanEnd && GLOBAL_FLAG.test(a))
if (flagAt !== -1) {
  const [flagWord, inline] = process.argv[flagAt].split(/=(.*)/s)
  const flag = flagWord === "--vault" ? "--vault" : "--workspace"
  const joined = inline !== undefined
  const target = joined ? inline : process.argv[flagAt + 1]
  if (!target || target.startsWith("-")) {
    console.error(
      flag === "--vault"
        ? "\u2716 --vault needs a path to a workspace, e.g. `--vault ../another-workspace`"
        : "\u2716 --workspace needs a path to a workspace, e.g. `-w ../another-workspace`"
    )
    process.exit(1)
  }
  /** @param {string} why */
  const refuse = why => {
    console.error(`\u2716 ${flag} ${target} \u2014 ${why}`)
    process.exit(1)
  }
  const resolved = path.resolve(process.cwd(), target)
  if (!fs.existsSync(resolved)) refuse("no such directory")
  // the TARGET must be a workspace root: a plain folder would be pinned, discovery would climb out
  // of it, and the verb would run in the workspace around it
  if (!isWorkspaceDir(resolved)) refuse(`${resolved} is not a workspace (no package.json with a "dreamteamer" section)`)
  process.chdir(resolved)
  // PROCESS-LOCAL, never an environment variable: an env var would reach every child — git hooks, an
  // extension spawning dt — and pin each of them to this workspace too.
  pinned()[Symbol.for("dreamteamer.workspace")] = process.cwd() // the physical path, as discovery will see it
  process.argv.splice(flagAt, joined ? 1 : 2)
}

const { run } = await import(engineEntry("cli"))
run(process.argv.slice(2))

/** Where `dt run`'s pass-through arguments begin — after the verb, the module and the script —
 *  or argv's length for every other verb. A global flag before the verb is skipped with its value.
 *  @param {string[]} argv @returns {number} */
function passThroughAt(argv) {
  let i = 2
  while (i < argv.length && GLOBAL_FLAG.test(argv[i])) i += argv[i].includes("=") ? 1 : 2
  return argv[i] === "run" ? i + 3 : argv.length
}

/** The process-wide registry the `--workspace` pin lives in (a symbol-keyed global, never the environment). */
function pinned() {
  return /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis))
}

/** The build this engine runs: ALWAYS the compiled dist/, in the npm package and in a checkout alike —
 *  the bin runs what ships, never the source. A checkout runs `npm run build` first (the test runner
 *  does it before tier 2); running the TypeScript directly is a separate, explicit choice.
 *  @param {string} name @returns {string} */
function engineEntry(name) {
  const entry = new URL(`../dist/${name}.js`, import.meta.url)
  if (!fs.existsSync(entry)) {
    console.error(
      `✖ this dreamteamer is not built (${fileURLToPath(new URL("..", import.meta.url))} has no dist/${name}.js); run \`npm run build\` there`
    )
    process.exit(1)
  }
  return entry.href
}

/** Does a directory's package.json carry a `dreamteamer` section — is it a workspace (or module) root? */
/** @param {string} dir @returns {boolean} */
function isWorkspaceDir(dir) {
  try {
    return "dreamteamer" in JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
  } catch {
    return false
  }
}
