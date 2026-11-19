// The first sixty seconds of a new user's life, driven against the PACKED TARBALL — exactly what a
// stranger gets from npm, so a missing entry in files[] fails CI instead of failing a stranger.
// Run by ci.yml on Linux, on node 20 and on Windows; `npm test` covers behaviour, this covers
// DISTRIBUTION and the OS the suite does not run on. release:next runs it on the tarball it publishes.
//
//   npm run smoke                                    packs, then smokes that
//   npx tsx scripts/first-run-smoke.ts <tarball>     smokes an already-packed tarball
//
// Through tsx, not node: the node 20 job runs it, and node 20 cannot strip types.
//
// ⚠ dt runs as `node <installed bin>`, never through npx: on Windows npx needs a shell, and a shell
// splits `--name "First memo"` at the space. The .bin link npx would have used is asserted instead.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync, type SpawnSyncOptions } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const windows = process.platform === "win32"

function exec(cmd: string, args: string[], cwd: string, quiet = false): string {
  const opts: SpawnSyncOptions = { cwd, encoding: "utf8", stdio: quiet ? "pipe" : ["ignore", "pipe", "inherit"] }
  const r = spawnSync(cmd, args, opts)
  const out = String(r.stdout ?? "")
  if (r.error) throw r.error
  if (r.status !== 0)
    throw new Error(`${path.basename(cmd)} ${args.join(" ")} exited ${r.status}\n${out}${r.stderr ?? ""}`)
  if (!quiet && out) process.stdout.write(out)
  return out
}

// npm through node itself when npm launched us (npm_execpath), so Windows needs no shell for npm.cmd.
function npm(args: string[], cwd: string, quiet = true): string {
  const cli = process.env.npm_execpath
  if (cli && /\.[cm]?js$/.test(cli)) return exec(process.execPath, [cli, ...args], cwd, quiet)
  if (windows) {
    const quoted = args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    const r = spawnSync("npm", quoted, { cwd, encoding: "utf8", shell: true })
    if (r.status !== 0) throw new Error(`npm ${args.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`)
    return r.stdout
  }
  return exec("npm", args, cwd, quiet)
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message)
}

export function pack(destination: string): string {
  const name = npm(["pack", "--silent", "--pack-destination", destination], root).trim().split("\n").pop()!
  return path.join(destination, name)
}

// `version`, when given, is what the installed engine must report — release:next stamps the tarball's
// package.json for the pack only, so this proves the stamp is in what was installed.
export function firstRunSmoke(tarball: string, version?: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-smoke-"))
  try {
    exec("git", ["init", "-q"], dir)
    exec("git", ["config", "user.email", "ci@example.com"], dir)
    exec("git", ["config", "user.name", "CI"], dir)
    npm(["init", "-y"], dir)
    npm(["install", "--silent", "--no-audit", "--no-fund", path.resolve(tarball)], dir)

    const bin = path.join(dir, "node_modules", ".bin")
    check(
      fs.existsSync(path.join(bin, "dreamteamer")) || fs.existsSync(path.join(bin, "dreamteamer.cmd")),
      "✖ the install linked no dreamteamer bin"
    )
    const entry = path.join(dir, "node_modules", "dreamteamer", "bin", "dreamteamer.js")
    const dt = (...args: string[]) => exec(process.execPath, [entry, ...args], dir)
    const dtQuiet = (...args: string[]) => exec(process.execPath, [entry, ...args], dir, true)

    if (version) {
      const reported = dtQuiet("--version").trim()
      check(reported.includes(version), `✖ the installed engine reports "${reported}", expected ${version}`)
    }

    dt("init")
    dt("compile")
    dt("check")
    // ⚠ VERB-FIRST since 0.12.0. This step kept the collection-first spelling and CI was red on every
    // push since 0.12.1 (2026-08-22) — six releases — because `release` is a separate workflow and it
    // was green. Verified against the packed tarball, not assumed.
    dt("add", "notes", "--title", "smoke")
    dt("list", "notes")
    dt("check")

    // The shapes that broke on Windows: a mixin, a skill with a nested file, an id with a `/`.
    // Compile used to key its runtime entries with `path.join`, so on Windows no mixin was found
    // ("mixin … does not exist (have: none)"), the skills indexes rendered empty and no skill file was
    // mirrored; source paths were stored with `\`, so a module listed none of its skills; record ids
    // were read back as `2026-01-02\x`. Each check below failed on that build.
    const mod = path.join(dir, "modules", "default")
    fs.writeFileSync(
      path.join(mod, "collections", "memos.collection.yaml"),
      [
        "name: memos",
        "description: A smoke collection — a mixin's fields under an id with a folder in it.",
        "mixins: [entity]",
        "ids:",
        "  from: '{{ created | date }}/{{ name | slug }}'",
        "  pattern: '^\\d{4}-\\d{2}-\\d{2}/[a-z0-9-]+$'",
        "fields: {}",
        "",
      ].join("\n")
    )
    const skill = path.join(mod, "skills", "smoke-skill")
    fs.mkdirSync(path.join(skill, "references"), { recursive: true })
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      [
        "---",
        "name: smoke-skill",
        "description: use when the first-run smoke needs a skill with a nested reference file",
        "---",
        "See references/more.md.",
        "",
      ].join("\n")
    )
    fs.writeFileSync(path.join(skill, "references", "more.md"), "more\n")

    dt("compile")
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8")
    check(/^- memos — /m.test(claude), "✖ memos missing from the CLAUDE.md collections index")
    check(claude.includes("smoke-skill"), "✖ smoke-skill missing from the CLAUDE.md skills index")
    check(
      fs.existsSync(path.join(dir, ".claude", "skills", "smoke-skill", "references", "more.md")),
      "✖ nested skill file not mirrored"
    )
    const status = dtQuiet("status")
    check(status.includes("is fresh"), `✖ status does not call a just-compiled workspace fresh\n${status}`)

    dt("add", "memos", "--name", "First memo")
    const listed = JSON.parse(dtQuiet("list", "memos", "--json")) as { id: string }[] | { records: { id: string }[] }
    const id = (Array.isArray(listed) ? listed : listed.records)[0]?.id ?? ""
    check(id.endsWith("/first-memo"), `✖ memo id is "${id}", expected <date>/first-memo`)
    dtQuiet("get", `memos/${id}`)
    dt("check")
    console.log("✔ first-run smoke")
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows can hold a file open a moment longer than the process that opened it; a temp dir left
      // behind is not a smoke failure.
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-smoke-pack-"))
  try {
    firstRunSmoke(process.argv[2] ?? pack(packDir))
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true })
  }
}
