#!/usr/bin/env node
// migrate-stubs — turn every stub record (`stub: true`, engines 0.41.0–0.44.x) into an entry of its repo's
// exports manifest, `dreamteamer-exports.json`, and delete the stub (cr-dt-004). Run it once per workspace
// that holds or reads stubs, on engine 0.45.0, right after `dt compile`:
//
//   node node_modules/dreamteamer/dist/scripts/migrate-stubs.js --root <workspace> [--dry-run]
//
// Per stub: an entry when a record of the workspace names the id, or when this workspace does not read its
// data completely (it cannot know, so it never deletes without an entry); the label is the stub's own title,
// with no holder; then the manifest is regenerated exactly as `dt exports` would, and ONE commit holds the
// manifest and the deleted stubs. --dry-run writes nothing.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// Run from a checkout (scripts/x.ts beside src/) and from the npm package (built to dist/scripts/x.js,
// one level under the engine's dist/*.js). Run as scripts/x.ts it imports the source beside it — running
// the TypeScript is that explicit choice; built, it imports the dist/ it sits in.
const SOURCE = fs.existsSync(new URL("../src/api.ts", import.meta.url))
const engine = <M>(name: string): Promise<M> =>
  import(new URL(SOURCE ? `../src/${name}.ts` : `../${name}.js`, import.meta.url).href)
const { Store } = await engine<typeof import("../src/store/Store.ts")>("store/Store")
const { parseRecord } = await engine<typeof import("../src/record/records.ts")>("record/records")
const { idFromRecordPath } = await engine<typeof import("../src/record/idFromRecordPath.ts")>("record/idFromRecordPath")
const { walk } = await engine<typeof import("../src/lib/walk.ts")>("lib/walk")
const { exportsFacts } = await engine<typeof import("../src/runtime/exportsFacts.ts")>("runtime/exportsFacts")
const { storageOf } = await engine<typeof import("../src/record/storageOf.ts")>("record/storageOf")
const { bodyFieldOf, recordTitleOf } = await engine<typeof import("../src/record/descriptor.ts")>("record/descriptor")
const { EXPORTS_FILE } = await engine<typeof import("../src/record/consts.ts")>("record/consts")
const { readExports } = await engine<typeof import("../src/record/readExports.ts")>("record/readExports")
const { serializeExports } =
  await engine<typeof import("../src/exports/serializeExports.ts")>("exports/serializeExports")
const { exportsContext } = await engine<typeof import("../src/record/exportsContext.ts")>("record/exportsContext")
const { outsideRefs } = await engine<typeof import("../src/record/outsideRefs.ts")>("record/outsideRefs")
const { planExports } = await engine<typeof import("../src/exports/planExports.ts")>("exports/planExports")

// `stub: true` in the FRONTMATTER only — a body quoting a stub is a real record
type Descriptor = import("../src/types.ts").Descriptor
type StoreT = InstanceType<typeof Store>

const isStubText = (text: string): boolean =>
  /^stub:\s*true\s*$/m.test(/^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1] ?? "")
const title = (d: Descriptor, fields: Record<string, unknown>, id: string): string =>
  String(fields[/\{\{\s*([A-Za-z_][\w]*)/.exec(recordTitleOf(d))?.[1]] ?? id)

/** Every record file of the workspace, per collection: `[{ d, id, file, stub }]`. */
function filesOf(store: StoreT): { d: Descriptor; id: string; file: string; stub: boolean }[] {
  const out: ReturnType<typeof filesOf> = []
  for (const d of store.descriptors.values()) {
    if (storageOf(d).runtime || storageOf(d).unavailable || storageOf(d).format === "binary") continue
    const dir = store.dir(d)
    if (!fs.existsSync(dir)) continue
    for (const file of walk(dir)) {
      const id = idFromRecordPath(d, path.relative(dir, file).split(path.sep).join("/"))
      if (id !== null) out.push({ d, id, file, stub: isStubText(fs.readFileSync(file, "utf8")) })
    }
  }
  return out
}

export function migrate(
  root: string,
  { dryRun = false, log = console.log }: { dryRun?: boolean; log?: (line: string) => void } = {}
) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const store = new Store({ root, pkg })
  const facts = exportsFacts(root)
  const ctx = exportsContext({
    root,
    descriptors: store.descriptors,
    own: facts.own,
    dataPath: facts.data,
  })
  const report = []
  const files = filesOf(store)
  const stubs = files.filter(f => f.stub)
  if (stubs.length) {
    const own = files
      .filter(f => !f.stub)
      .map(f => ({
        collection: f.d.name,
        id: f.id,
        descriptor: f.d,
        fields: parseRecord(f.file, f.d, bodyFieldOf(f.d)),
      }))
    const named = outsideRefs({ records: own, held: () => false, resolve: () => null, namespaces: store.namespaces })
    const complete = ctx.complete()
    const entries = readExports(root) ?? {}
    const rows = []
    for (const s of stubs) {
      const ref = `${s.d.name}/${s.id}`
      const referrers = named.get(ref)?.referrers ?? []
      if (!referrers.length && complete) {
        rows.push({ ref, fate: "deleted — nothing in its repo references it" })
        continue
      }
      const e = { label: title(s.d, parseRecord(s.file, s.d, bodyFieldOf(s.d)), s.id) }
      ;(entries[s.d.name] ??= {})[s.id] = entries[s.d.name][s.id] ?? e
      rows.push({
        ref,
        fate: `entry ${JSON.stringify(e)}${referrers.length ? ` — named by ${referrers.slice(0, 3).join(", ")}${referrers.length > 3 ? ` +${referrers.length - 3}` : ""}` : " — kept: this workspace does not read the repo completely"}`,
      })
    }
    const dir = root
    log(
      `this workspace · ${stubs.length} stub${stubs.length === 1 ? "" : "s"}${dryRun ? " (dry run — nothing written)" : ""}`
    )
    for (const r of rows) log(`    ${r.ref} — ${r.fate}`)
    report.push({ repo: null as string | null, rows })
    if (!dryRun) {
      for (const s of stubs) fs.rmSync(s.file)
      fs.writeFileSync(path.join(dir, EXPORTS_FILE), serializeExports(entries) ?? "{}\n")
      const plan = planExports(new Store({ root, pkg })) // as dt exports would, on the migrated tree
      if (plan.text === null) fs.rmSync(plan.file, { force: true })
      else fs.writeFileSync(plan.file, plan.text)
      const git = (args: string[]): string =>
        execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] })
          .toString()
          .trim()
      // the manifest only when there is one or git tracks one: all-unreferenced stubs leave none to add
      const tracked = git(["ls-files", "--", EXPORTS_FILE]) !== ""
      const paths = [
        ...(tracked || fs.existsSync(path.join(dir, EXPORTS_FILE)) ? [EXPORTS_FILE] : []),
        ...stubs.map(s => path.relative(dir, s.file)),
      ]
      git(["add", "-A", "--", ...paths])
      git([
        "commit",
        "--only",
        "-q",
        "-m",
        `dreamteamer: migrate ${stubs.length} stub record(s) to ${EXPORTS_FILE}`,
        "--",
        ...paths,
      ])
      log(`    ✔ committed ${git(["rev-parse", "--short", "HEAD"])}`)
    }
  }
  if (!report.length) log("no stub records found")
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf("--root")
  try {
    migrate(path.resolve(at >= 0 ? argv[at + 1] : "."), {
      dryRun: argv.includes("--dry-run"),
    })
  } catch (e) {
    console.error(`✖ ${e.message}`)
    process.exit(1)
  }
}
