import path from "node:path"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import type { Workspace } from "../types.ts"
import { buildClone } from "../workspace/buildClone.ts"
import { tryGit } from "../workspace/tryGit.ts"

// dreamteamer install --clone <url> [name] — clone a module for development AND
// record it in the committed lockfile map (story 5.3)
export function installClone(ws: Workspace, url: string, name?: string): number {
  if (!url) throw new Error("usage: dreamteamer install --clone <git-url> [name]")
  name = name && !name.startsWith("--") ? name : path.basename(url, ".git")
  const dest = path.join(ws.root, "git_modules", name)
  if (fs.existsSync(dest)) throw new Error(`git_modules/${name} already exists`)
  fs.mkdirSync(path.join(ws.root, "git_modules"), { recursive: true })
  execFileSync("git", ["clone", url, dest], { stdio: "inherit" })
  buildClone(dest, name)
  const ref = tryGit(dest, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "main"
  const pkgPath = path.join(ws.root, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  pkg.dreamteamer.git_modules = { ...pkg.dreamteamer.git_modules, [name]: { url, ref } }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n")
  execFileSync("git", ["add", "package.json"], { cwd: ws.root })
  execFileSync("git", ["commit", "--quiet", "-m", `dreamteamer: install ${name} (git module)`, "--", "package.json"], {
    cwd: ws.root,
  })
  console.log(`✔ git_modules/${name} (ref ${ref})`)
  console.log("✔ package.json dreamteamer.git_modules updated")
  return 0
}
