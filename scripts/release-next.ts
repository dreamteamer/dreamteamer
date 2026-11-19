#!/usr/bin/env node
// release:next — publish a commit-stamped prerelease from this machine under the `next` dist-tag, so
// `npm install dreamteamer` keeps resolving `latest` and only `dreamteamer@next` reaches it.
//
//   npm run release:next                 gates, pack, scan, smoke, confirm, publish
//   npm run release:next -- --full       run the full suite instead of tier 1
//   npm run release:next -- --no-names   skip the private-name scan on purpose (LEAK_NAMES unset)
//   npm run release:next -- --yes        publish without the confirmation prompt
//
// It moves no git tag and makes no commit: package.json carries the prerelease version only while
// `npm pack` runs, and is restored byte for byte before anything else happens. The commit is in the
// version instead (0.50.1-next.20261119143005.g7b95f2d), and a clean tree is required so that commit
// is exactly what was packed.
//
// ⚠ This is the local twin of release.yml's gates, not a replacement: there is no provenance, and
// the private-name list lives in a GitHub secret, so the name scan runs only when LEAK_NAMES is
// exported — and refuses without it unless --no-names says so out loud. The scan reads the UNPACKED
// TARBALL, because that is what a stranger downloads.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

export const DIST_TAG = "next"

// The same patterns release.yml's leak gate greps for.
export const SECRET_SHAPES =
  /sk-ant-[A-Za-z0-9_-]{20}|sk-[A-Za-z0-9]{32}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]{10,}|glpat-[0-9A-Za-z_-]{20}|npm_[A-Za-z0-9]{36}|-----BEGIN [A-Z ]*PRIVATE KEY-----/
const HEBREW = /[֐-׿]/

// A stable version gets its next patch; a prerelease keeps its core, since it already names an
// unreleased version. The timestamp orders two builds of one day, and the sha is prefixed with `g`
// (git describe's convention) because an all-digit identifier with a leading zero is not semver.
export function nextVersion(current: string, now: Date, sha: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(current)
  if (!m) throw new Error(`package.json version "${current}" is not semver`)
  const [major, minor, patch] = [m[1], m[2], Number(m[3])]
  const core = m[4] ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14)
  if (!/^[0-9a-f]{4,40}$/.test(sha)) throw new Error(`"${sha}" is not a commit sha`)
  return `${core}-${DIST_TAG}.${stamp}.g${sha}`
}

// Rewrites only the version value, so restoring the original text is a byte-for-byte undo.
export function withVersion(packageJson: string, version: string): string {
  let count = 0
  const out = packageJson.replace(/("version"\s*:\s*)"[^"]*"/, (_, key: string) => {
    count++
    return `${key}"${version}"`
  })
  if (count !== 1) throw new Error('package.json has no "version" field to stamp')
  return out
}

export function hebrewAllowed(allowFile: string): Set<string> {
  const allowed = new Set<string>()
  for (const line of allowFile.split("\n")) {
    if (/^\s*(#|$)/.test(line)) continue
    const [file, rule] = line.split("\t")
    if (rule === "hebrew") allowed.add(file)
  }
  return allowed
}

export interface ScanFile {
  path: string
  bytes: Buffer
}

export interface ScanOptions {
  names: RegExp | null
  hebrewAllowed: Set<string>
}

export interface ScanHits {
  names: string[]
  secrets: string[]
  hebrew: string[]
}

// Paths only, never the matching content: the names being looked for are themselves private.
export function scan(files: ScanFile[], opts: ScanOptions): ScanHits {
  const hits: ScanHits = { names: [], secrets: [], hebrew: [] }
  for (const f of files) {
    if (f.bytes.includes(0)) continue // binary, as grep -I skips it
    const text = f.bytes.toString("utf8")
    if (opts.names?.test(text)) hits.names.push(f.path)
    if (SECRET_SHAPES.test(text)) hits.secrets.push(f.path)
    if (HEBREW.test(text) && !opts.hebrewAllowed.has(f.path)) hits.hebrew.push(f.path)
  }
  return hits
}

function walk(dir: string, base = dir): ScanFile[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return walk(full, base)
    return [{ path: path.relative(base, full).split(path.sep).join("/"), bytes: fs.readFileSync(full) }]
  })
}

const root = fileURLToPath(new URL("..", import.meta.url))

function fail(message: string): never {
  console.error(`✖ ${message}`)
  process.exit(1)
}

function step(title: string): void {
  console.log(`\n▸ ${title}`)
}

function capture(cmd: string, args: string[], cwd = root): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" })
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`)
  return r.stdout.trim()
}

function run(cmd: string, args: string[], cwd = root): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" })
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} exited ${r.status}`)
}

// A stranger's first minute, against the exact tarball about to be published: install it into an
// empty git repo, then init → compile → check → write a record → read it back → check.
function smoke(tarball: string, dir: string, version: string): void {
  fs.mkdirSync(dir)
  capture("git", ["init", "-q"], dir)
  capture("git", ["config", "user.email", "smoke@example.com"], dir)
  capture("git", ["config", "user.name", "Smoke"], dir)
  capture("npm", ["init", "-y"], dir)
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball], dir)
  const dt = (...args: string[]) => capture("npx", ["--no-install", "dreamteamer", ...args], dir)
  const reported = dt("--version")
  if (!reported.includes(version)) fail(`the installed engine reports "${reported}", expected ${version}`)
  dt("init")
  dt("compile")
  dt("check")
  dt("add", "notes", "--title", "smoke")
  if (!dt("list", "notes").includes("smoke")) fail("the note written by the smoke is not listed")
  dt("check")
  console.log("  ✔ init, compile, check, add, list")
}

async function main(argv: string[]): Promise<void> {
  const known = new Set(["--full", "--no-names", "--yes"])
  const unknown = argv.filter(a => !known.has(a))
  if (unknown.length) fail(`unknown flag ${unknown.join(", ")} — expected ${[...known].join(", ")}`)
  const flags = new Set(argv)

  step("the tree is clean")
  if (capture("git", ["status", "--porcelain"]))
    fail("the working tree has changes — commit or stash them, so the stamped commit is what ships")

  const leakNames = process.env.LEAK_NAMES?.trim()
  if (!leakNames && !flags.has("--no-names"))
    fail(
      "LEAK_NAMES is not set, so the private-name scan cannot run. Export it, or pass --no-names to skip it on purpose."
    )

  step("npm login")
  console.log(`  publishing as ${capture("npm", ["whoami"])}`)

  const pkgFile = path.join(root, "package.json")
  const original = fs.readFileSync(pkgFile, "utf8")
  const { name, version: current } = JSON.parse(original) as { name: string; version: string }
  const sha = capture("git", ["rev-parse", "--short=7", "HEAD"])
  const version = nextVersion(current, new Date(), sha)
  console.log(`  ${name}@${version}  (from ${current} at ${sha})`)

  step(flags.has("--full") ? "gates + the full suite" : "gates + tier 1")
  run("npm", ["run", "typecheck"])
  run("npm", ["run", "lint"])
  run("npm", ["run", "format:check"])
  run("npm", flags.has("--full") ? ["test"] : ["test", "--", "--unit"])

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-release-next-"))
  try {
    step("pack (package.json stamped for the pack only)")
    let tarball: string
    try {
      fs.writeFileSync(pkgFile, withVersion(original, version))
      tarball = path.join(tmp, capture("npm", ["pack", "--silent", "--pack-destination", tmp]).split("\n").pop()!)
    } finally {
      fs.writeFileSync(pkgFile, original)
    }
    if (capture("git", ["status", "--porcelain"])) fail("the tree is not clean after packing — inspect `git status`")
    console.log(`  ${path.basename(tarball)}, package.json restored`)

    const unpacked = path.join(tmp, "unpacked")
    fs.mkdirSync(unpacked)
    capture("tar", ["-xzf", tarball, "-C", unpacked])
    const pkgDir = path.join(unpacked, "package")
    const packed = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version: string }
    if (packed.version !== version) fail(`the tarball says ${packed.version}, expected ${version}`)

    step(`leak scan of the tarball${leakNames ? "" : " (private names SKIPPED: --no-names)"}`)
    const allowFile = path.join(root, ".leak-scan-allow")
    const files = walk(pkgDir)
    const hits = scan(files, {
      names: leakNames ? new RegExp(leakNames, "i") : null,
      hebrewAllowed: fs.existsSync(allowFile) ? hebrewAllowed(fs.readFileSync(allowFile, "utf8")) : new Set(),
    })
    const report: [string, string[]][] = [
      ["match a private name", hits.names],
      ["match a credential shape", hits.secrets],
      ["carry Hebrew outside .leak-scan-allow", hits.hebrew],
    ]
    for (const [what, paths] of report)
      if (paths.length) console.error(`  ${paths.length} file(s) ${what}:\n    ${paths.join("\n    ")}`)
    if (report.some(([, paths]) => paths.length)) fail("the tarball failed the leak scan — nothing was published")
    console.log(`  ✔ ${files.length} files clean`)

    step("first-run smoke against the tarball")
    smoke(tarball, path.join(tmp, "smoke"), version)

    const size = (fs.statSync(tarball).size / 1024).toFixed(0)
    console.log(
      `\n  ${name}@${version}\n  dist-tag: ${DIST_TAG} (latest is not touched)\n  ${files.length} files, ${size} kB`
    )
    if (!flags.has("--yes")) {
      if (!process.stdin.isTTY) fail("no terminal to confirm on — pass --yes to publish non-interactively")
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const answer = await rl.question("  Publish? This version is permanent. [y/N] ")
      rl.close()
      if (!/^y(es)?$/i.test(answer.trim())) fail("not published")
    }

    step("publish")
    run("npm", ["publish", tarball, "--tag", DIST_TAG, "--access", "public"])
    console.log(`\n✔ published ${name}@${version} — install with: npm install ${name}@${DIST_TAG}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
