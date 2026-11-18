import path from "node:path"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { commitOf } from "./commitOf.ts"
import { isLink } from "./isLink.ts"
import { offRef } from "./offRef.ts"
import { declaredGitModules } from "../workspace/declaredGitModules.ts"
import type { Workspace } from "../types.ts"
import { QUIET } from "../lib/consts.ts"
import { appendMissing } from "../lib/appendMissing.ts"
import { buildClone } from "./buildClone.ts"
import { tryGit } from "../lib/git/tryGit.ts"

/**
 * dreamteamer install — restore git_modules/ working clones from the committed lockfile map, and what each
 * restored clone NEEDS in turn (`declaredGitModules`, the npm model): a layer a clone's manifest names is
 * cloned ONCE at the top level and linked under the clone — or, where it disagrees with what the top holds,
 * cloned under the clone itself — to a fixpoint, since a clone just restored may need more. Never refuses.
 */
export function install({ root, pkg }: Pick<Workspace, "root" | "pkg">): number {
  const unreachable: string[] = [],
    done = new Set<string>()
  let declared: ReturnType<typeof declaredGitModules>
  const clone = (url: string, ref: string, dest: string, name: string, note: string): void => {
    console.log(`… cloning ${url} → ${path.relative(root, dest)} (${ref})${note}`)
    try {
      execFileSync("git", ["clone", "--branch", ref, url, dest], { stdio: "inherit" })
    } catch {
      // one unreachable clone must not abandon the rest. the lockfile is a map of PRIVATE
      // repos as often as public ones, so "the current credentials cannot see this one" is
      // ordinary — a fresh machine, a collaborator, a cloud sandbox. aborting there left a
      // half-restored workspace and named only the first failure.
      fs.rmSync(dest, { recursive: true, force: true }) // git leaves the partial dir behind
      unreachable.push(name)
      console.warn(`⚠ ${path.relative(root, dest)}: clone failed — skipped (${url})`)
      return
    }
    buildClone(dest, name)
  }
  for (;;) {
    declared = declaredGitModules(pkg, root)
    /** a clone to make: a top-level one has no `by`; a nested one sits under its declarer */
    type Task = { name: string; dest: string; note: string; url: string | undefined; ref: string; by?: string }
    const top: Task[] = [...declared.map]
      .filter(([n]) => !done.has(n))
      .map(([name, e]) => ({
        ...e,
        name,
        dest: path.join(root, "git_modules", name),
        note: e.declarers.some(Boolean) ? ` — for ${e.declarers.filter(Boolean).join(", ")}` : "",
      }))
    const under: Task[] = declared.nested
      .filter(n => !done.has(`${n.by}/${n.name}`))
      .map(n => ({
        ...n,
        dest: path.join(root, n.by, "git_modules", n.name),
        note: ` — nested: git_modules/${n.name} is ${n.top.url} (${n.top.ref})`,
      }))
    if (!top.length && !under.length) break
    for (const t of [...top, ...under]) {
      done.add(t.by ? `${t.by}/${t.name}` : t.name)
      fs.mkdirSync(path.dirname(t.dest), { recursive: true })
      // ⚠ A LINK IS NOT A CLONE. A declarer that agreed with the top at the first install was given a
      // link; once its declaration diverges its copy is nested HERE, and the link standing where the
      // nested clone goes must be replaced — never re-pointed through, which would move the shared
      // top-level clone every other reader sits on (the first review of 0.46.0, finding eng-01).
      if (t.by && isLink(t.dest)) fs.unlinkSync(t.dest)
      if (fs.existsSync(t.dest)) {
        if (!repoint(t.dest, path.relative(path.join(root, "git_modules"), t.dest), t.ref)) unreachable.push(t.name)
        continue
      }
      clone(t.url, t.ref, t.dest, t.name, t.note)
      if (t.by) excludeIn(path.join(root, t.by), `git_modules/${t.name}`)
    }
  }
  if (!done.size) {
    console.log("✔ no git_modules declared — nothing to restore")
    return 0
  }
  for (const [name, { declarers }] of declared.map)
    for (const by of declarers) if (by && !unreachable.includes(name)) linkLayer(root, by, name)
  for (const [name, list] of declared.mismatches.reduce(
    (g, m) => g.set(m.name, [...(g.get(m.name) ?? []), m]),
    new Map<string, typeof declared.mismatches>()
  )) {
    // Map.groupBy is Node 21+
    console.warn(
      `⚠ git_modules/${name}: this workspace's declaration overrides ${list.map(m => `${m.by} (${m.what} ${m.theirs})`).join(", ")}`
    )
  }
  for (const u of declared.unmet)
    console.warn(
      `⚠ ${u.by}: dreamteamer-exports.json names ${u.holder}, which no git_modules entry of the clone provides`
    )
  // non-zero, because the workspace is NOT what the lockfile describes: modules are missing or off
  // their ref, and `check` will report references into them as unknown collections.
  if (unreachable.length)
    console.error(`✖ ${unreachable.length} module(s) are not what the lockfile declares: ${unreachable.join(", ")}`)
  return unreachable.length ? 1 : 0
}

/** The link a declarer finds its layer through — `<by>/git_modules/<name> -> ../../<name>`, the pnpm shape:
 *  explicit on disk, resolved by a tool that knows nothing of dreamteamer. A clone of its own standing there
 *  may hold work: left as it is, and said — `dt status` draws it too. */
function linkLayer(root: string, by: string, name: string): void {
  // relative from wherever the declarer sits — a nested copy's own needs link from two levels deeper
  const at = path.join(root, by, "git_modules", name),
    want = path.relative(path.dirname(at), path.join(root, "git_modules", name))
  let st = null
  try {
    st = fs.lstatSync(at)
  } catch {
    /* nothing there */
  }
  if (st && !st.isSymbolicLink()) {
    console.log(`… ${by}/git_modules/${name} is a clone of its own — left as it is`)
    return
  }
  if (st && fs.readlinkSync(at) === want) return
  if (st) fs.unlinkSync(at)
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.symlinkSync(want, at)
  excludeIn(path.join(root, by), `git_modules/${name}`)
  console.log(`✔ ${by}/git_modules/${name} → git_modules/${name}`)
}

/** Ignore `rel` in a clone's own `.git/info/exclude` when its .gitignore does not already cover it — never
 *  in a tracked file, which would dirty the clone. */
function excludeIn(clone: string, rel: string): void {
  if (ran(clone, ["check-ignore", "-q", rel])) return
  const exclude = path.resolve(
    clone,
    tryGit(clone, ["rev-parse", "--git-path", "info/exclude"]) ?? path.join(".git", "info", "exclude")
  )
  fs.mkdirSync(path.dirname(exclude), { recursive: true })
  appendMissing(exclude, rel)
}

const ran = (cwd: string, args: string[], timeout?: number): boolean => {
  try {
    execFileSync("git", args, { cwd, stdio: QUIET, timeout })
    return true
  } catch {
    return false
  }
}

/** Move a clone to its declared ref, or refuse and change nothing. Returns false on a refusal. */
function repoint(dest: string, name: string, ref: string): boolean {
  const at = `git_modules/${name}`
  if (!offRef(dest, ref)) {
    console.log(`✔ ${at} present (${ref})`)
    return true
  }
  const refuse = (why: string): false => {
    console.error(`✖ ${at}: not on ${ref}, and ${why} — nothing was moved`)
    return false
  }
  if (tryGit(dest, ["status", "--porcelain"]))
    return refuse(`it has uncommitted changes — commit or stash them in ${at}, then re-run dt install`)
  const mine = ["HEAD", ...(commitOf(dest, `refs/heads/${ref}`) ? [`refs/heads/${ref}`] : [])]
  const local = Number(tryGit(dest, ["rev-list", "--count", ...mine, "--not", "--remotes", "--tags"]) ?? 0)
  if (local)
    return refuse(
      `it holds ${local} commit(s) on no remote — push them from ${at} (or drop them), then re-run dt install`
    )
  const before = commitOf(dest, "HEAD")?.slice(0, 7)
  if (!ran(dest, ["fetch", "--quiet", "--tags", "origin"], 120_000)) return refuse("fetching origin failed")
  if (!offRef(dest, ref)) {
    console.log(`✔ ${at} present (${ref})`)
    return true
  }
  const branch = commitOf(dest, `refs/remotes/origin/${ref}`)
  if (!branch && !commitOf(dest, ref))
    return refuse(`origin has no branch, tag or commit "${ref}" — fix dreamteamer.git_modules.${name}.ref`)
  const to = branch ? ["-B", ref, `origin/${ref}`] : commitOf(dest, `refs/heads/${ref}`) ? [ref] : ["--detach", ref]
  if (!ran(dest, ["checkout", "--quiet", ...to], 60_000)) return refuse("the checkout failed")
  console.log(`✔ ${at}: ${before} → ${ref} (${commitOf(dest, "HEAD").slice(0, 7)})`)
  buildClone(dest, name)
  return true
}
