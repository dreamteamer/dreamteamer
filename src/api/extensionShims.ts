// The names of the released engine's API that extensions call and the protocol host does not: each one call into
// this engine, or the released shape around one.
import { fileURLToPath } from "node:url"
import { compile as compileModel } from "../compile/compile.ts"
import { buildModel } from "../model/buildModel.ts"
import { check as checkModel } from "../store/check.ts"

/** the released command's path, which extensions spawn */
const engineBin = fileURLToPath(new URL("../../bin/dreamteamer.js", import.meta.url))

/** `--name value`, `--name=value`, a bare `--flag` (true) and the rest positional; a repeated flag is a list */
function parseArgs(argv: string[]) {
  const flags: Record<string, unknown> = {}
  const pos: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith("--")) {
      pos.push(t)
      continue
    }
    const eq = t.indexOf("=")
    const [k, v] =
      eq > -1
        ? [t.slice(2, eq), t.slice(eq + 1)]
        : [t.slice(2), argv[i + 1]?.startsWith("--") === false ? argv[++i] : true]
    flags[k] = k in flags ? [flags[k], v].flat() : v
  }
  const res = { flags, pos }
  return res
}

/** a reference split at the longest collection name it starts with, or null */
function splitRef(descriptors: Map<string, unknown>, ref: string) {
  const name = [...descriptors.keys()].filter((t) => ref.startsWith(t + "/")).sort((x, y) => y.length - x.length)[0]
  const res = name === undefined ? null : { collection: name, id: ref.slice(name.length + 1) }
  return res
}

/**
 * Check every record, printed as the released `check` prints it (`✖ <where>` then each finding indented, a closing
 * count); 0 when nothing is wrong, 1 otherwise. Warnings are printed and do not fail it.
 */
function check(ws: { root: string }): number {
  const { records, issues } = checkModel(buildModel(ws.root))
  let last = ""
  for (const t of issues.filter((i) => i.severity === "error")) {
    if (t.where !== last) console.log(`✖ ${t.where}`)
    console.log(`    ${t.message}`)
    last = t.where
  }
  for (const t of issues.filter((i) => i.severity === "warning")) console.log(`⚠ ${t.where} — ${t.message}`)
  const n = issues.filter((i) => i.severity === "error").length
  console.log(
    n ? `${n} violation${n === 1 ? "" : "s"}. files were NOT modified.` : `✔ 0 violations (${records} records)`,
  )
  return n ? 1 : 0
}

/** compile the workspace: the released layout under .dreamteamer/, and this engine's .dt/ */
function compile(ws: { root: string }): number {
  compileModel(buildModel(ws.root))
  return 0
}

/** the extension-facing shims, by the released API's names */
export const extensionShims = { engineBin, parseArgs, splitRef, check, compile, CHECK_WARNINGS: true }
