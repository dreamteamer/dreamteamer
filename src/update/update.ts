import path from "node:path"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import { declaredGitModules } from "../record/declaredGitModules.ts"
import type { Workspace } from "../types.ts"
import { buildClone } from "../workspace/buildClone.ts"
import { discoverModules } from "../workspace/discoverModules.ts"
import { tryGit } from "../workspace/tryGit.ts"

// dreamteamer update [<name>] — pull each lockfile-declared git_modules clone forward
// (ff-only on its recorded ref) and rebuild it. dirty clones are skipped, never touched.
// the caller (cli) runs compile afterwards — a pulled module may change sources.
export function update({ root, pkg }: Pick<Workspace, "root" | "pkg">, only?: string | null): number {
  const map = Object.fromEntries(declaredGitModules(pkg, root).map) // a hoisted layer is pulled forward too
  if (only && !map[only])
    throw new Error(`"${only}" is not in dreamteamer.git_modules (known: ${Object.keys(map).join(", ") || "none"})`)
  const names = only ? [only] : Object.keys(map)
  if (!names.length) {
    console.log("✔ no git_modules declared — nothing to update")
    return 0
  }
  for (const name of names) {
    const { ref } = map[name]
    const dest = path.join(root, "git_modules", name)
    if (!fs.existsSync(dest)) {
      console.warn(`⚠ git_modules/${name} missing — run \`dreamteamer install\` first; skipped`)
      continue
    }
    if (tryGit(dest, ["status", "--porcelain"])) {
      console.warn(`⚠ git_modules/${name} is dirty — skipped (commit or stash there, then re-run)`)
      continue
    }
    const before = tryGit(dest, ["rev-parse", "--short", "HEAD"])
    try {
      execFileSync("git", ["pull", "--ff-only", "origin", ref], { cwd: dest, stdio: "inherit" })
    } catch {
      console.warn(`⚠ git_modules/${name}: ff-only pull of origin/${ref} failed (diverged?) — left at ${before}`)
      continue
    }
    const after = tryGit(dest, ["rev-parse", "--short", "HEAD"])
    if (before === after) {
      console.log(`✔ git_modules/${name} already up to date (${after})`)
      continue
    }
    buildClone(dest, name) // deps/dist may have moved with the pull
    console.log(`✔ git_modules/${name} ${before} → ${after}`)
  }
  // dev-clone semantics: these clones SHADOW any node_modules copy of the same module —
  // what just updated is what runs. npm-channel modules are updated via npm, not here.
  console.log("… git_modules clones shadow node_modules copies — the updated clones win")
  for (const m of discoverModules(root, pkg).modules) {
    if (m.channel === "npm")
      console.log(`… npm-channel module ${m.name} is not managed here — \`npm update ${m.name}\` to pull it forward`)
  }
  return 0
}
