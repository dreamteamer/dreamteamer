import path from "node:path"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import { SKELETON_KINDS } from "./consts.ts"
import { seedBlock } from "./seedBlock.ts"
import { ensureEditorRecommendation } from "../compile/ensureEditorRecommendation.ts"
import type { Flags } from "../types.ts"
import { KINDS } from "../compile/consts.ts"
import { appendMissing } from "../lib/appendMissing.ts"

const GITIGNORE = `node_modules/
git_modules/
.worktrees/
.dreamteamer/
.claude/
.agents/
.cursor/
/CLAUDE.md
/AGENTS.md
/GEMINI.md
/NOTEBOOKLM.md
.env
media/
.screenshots/
.cache/
`

/**
 * A brand-new workspace with no collections gives a user nothing to run, and makes `compile` warn
 * that the module `init` just created "contributed no recognised sources" — a warning about its own
 * output, which reads as a broken install. One starter collection answers both. `notes` is
 * deliberately the most generic thing a workspace can hold.
 */
const STARTER_COLLECTION = `name: notes
record_title: '{{ title }}'
description: A dated note — the starter collection init seeds, to rename or replace with what this workspace actually keeps.
ids:
  from: '{{ created | date }}--{{ title | slug }}'
  pattern: ^\\d{4}-\\d{2}-\\d{2}--[a-z0-9-]+$
fields:
  title:
    type: string
    required: true
    description: What this note is called.
  body:
    type: markdown
    body: true
    description: The note itself.
display:
  nav:
    icon: sticky_note_2
`

const ENV_EXAMPLE = `# secrets for skills and modules go here (copy to .env; .env is never committed).
# modules declare the env keys they require in their package.json dreamteamer.env list.
`

/** `commit: false` is `init --ready`'s: a bootstrap writes and never commits (checkout.js `bootstrap`). */
export function init({ flags = {} as Flags, root = process.cwd(), commit = true } = {}): 0 {
  // both take a value on the command line (`--name x`, `--data-path x`)
  const name = (flags.name as string) ?? path.basename(root)
  const dataPath = (flags.data_path as string) ?? "data"
  // package.json: create or update — the single manifest
  const pkgPath = path.join(root, "package.json")
  const pkg = fs.existsSync(pkgPath)
    ? JSON.parse(fs.readFileSync(pkgPath, "utf8"))
    : { name, private: true, version: "0.0.1" }
  const existed = fs.existsSync(pkgPath),
    had = pkg.dreamteamer ?? {}
  pkg.dreamteamer = seedBlock(flags, pkg.dreamteamer)
  // an existing block already holding every seeded key is left BYTE-FOR-BYTE: re-running init (or a
  // repeated `init --ready`) must not reformat the operator's file into a diff that changes nothing
  if (!existed || Object.keys(pkg.dreamteamer).some(k => !(k in had)))
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n")

  // folder skeleton — the workspace's own sources are an inline module, kinds FLAT at its root
  const wm = pkg.dreamteamer.workspace_module
  const systemRoot = wm ? path.join(root, "modules", wm) : root
  for (const kind of SKELETON_KINDS) fs.mkdirSync(path.join(systemRoot, kind), { recursive: true })
  if (wm) {
    const modulePkg = path.join(systemRoot, "package.json")
    if (!fs.existsSync(modulePkg)) {
      // `files` is the npm publish surface: every kind a module can ship, since a new one here
      // is an engine change that would otherwise silently stop being packaged.
      // `description` is npm's own key and the one compile falls back to for the module's sentence
      // — the line that heads this module's group in the orientation block. Seeded so a fresh
      // workspace does not open with a warning about the module init just made; the operator
      // replaces it with what THIS workspace is for.
      fs.writeFileSync(
        modulePkg,
        JSON.stringify(
          {
            name: wm,
            private: true,
            version: "0.0.1",
            description: "This workspace's own collections, skills and commands.",
            files: [...KINDS],
            dreamteamer: {},
          },
          null,
          "\t"
        ) + "\n"
      )
    }
  }
  // one starter collection, so `compile` has something to report instead of warning about the
  // empty module it just made, and so a fresh workspace has something to run.
  const starter = path.join(systemRoot, "collections", "notes.collection.yaml")
  if (!fs.existsSync(starter)) fs.writeFileSync(starter, STARTER_COLLECTION)
  fs.mkdirSync(path.join(root, dataPath), { recursive: true })
  // NO `state/` is created. It was decision-4's home for operational records — runs, triggers,
  // registries, cursors — and every one of those seven collections has since been deleted. When a
  // real operational-data need finally arrived (cached provider readings) it went to a gitignored
  // `.cache/*.jsonl` instead, because thousands of append-only readings are the wrong shape for
  // records at all. So `state/` is a working facility with no users, and seeding an empty folder
  // for it is the "capability that needs a record before it exists" smell. The MECHANISM is kept —
  // `storage.path: state/<name>` still compiles, writes, lists and checks — so a workspace that
  // wants a second root has one; the engine just stops advertising a fork nobody has taken.

  // NO user record is seeded, and there is no `users` collection — both removed from core in 0.8.0.
  // It failed the "does the ENGINE read it?" test on a circular justification: `users` was core
  // because `@me` resolved against it, and `@me` existed because `users` was core. Nothing else in
  // the compiler, the store or `check` ever read a user record. One record per workspace, whose only
  // job was to restate `git config user.name` in a file that then had to AGREE with it — and when it
  // disagreed the symptom was an empty inbox with no error (decision 99b), a trap that now cannot
  // happen because there is nothing to disagree with.
  //
  // A workspace that needs people as records ships its own collection (a module's `contacts` already
  // does), and reads the operator from git where it needs one. `teams` went the same way 2026-07-31.

  // .gitignore + .env.example (append-if-missing, never clobber) + the editor recommendation, so
  // the first window opened on this workspace offers the extension instead of leaving it to be found
  appendMissing(path.join(root, ".gitignore"), GITIGNORE)
  ensureEditorRecommendation(root)
  if (!fs.existsSync(path.join(root, ".env.example"))) fs.writeFileSync(path.join(root, ".env.example"), ENV_EXAMPLE)

  // one init commit (if we're in a git repo) — of the files init WROTE, and nothing else. It used to
  // `git add --all`, which in an existing repo swept every unrelated staged and unstaged change into
  // a commit titled "init workspace": the one write in this engine that was not pathspec-scoped.
  // `commit -- <paths>` also leaves anything the operator had already staged exactly as it was.
  if (!commit) return 0
  const written = [
    "package.json",
    ".gitignore",
    ".env.example",
    ".vscode/extensions.json",
    ...(wm ? [path.join("modules", wm, "package.json")] : []),
    path.relative(root, starter),
  ].filter(f => fs.existsSync(path.join(root, f)))
  try {
    // stdio ignored on purpose: this whole block is best-effort, and execFileSync forwards the
    // child's stderr to ours by default — so a plain `dreamteamer init` in a non-git folder
    // printed git's raw "fatal: not a git repository" above our own handled warning.
    execFileSync("git", ["add", "--", ...written], { cwd: root, stdio: "ignore" })
    execFileSync("git", ["commit", "--quiet", "-m", `dreamteamer: init workspace ${name}`, "--", ...written], {
      cwd: root,
      stdio: "ignore",
    })
  } catch {
    console.warn("⚠ not a git repo (or nothing to commit) — init files written, no commit")
  }

  console.log(`✔ workspace ${name} initialized — run \`dreamteamer compile\` to materialize the runtime`)
  return 0
}
