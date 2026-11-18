import path from "node:path"
import fs from "node:fs"

/**
 * Where a write to `p` actually lands: every component resolved in order, a link's target spliced in
 * and resolved in turn — so a link whose leaf does not exist yet is still followed through each link
 * among its ancestors, and `..` means the parent of what was REACHED, never the lexical parent. A
 * missing component ends resolution (nothing below it can be a link). Null past 40 links: a loop.
 */
function landing(p: string): string | null {
  // the root (`/`, or `C:\` on Windows — never a segment to join, which made every path land at `C:\C:\…`)
  // is the starting point; the segments after it are walked, either separator accepted
  // the separator is the platform's ONLY: a backslash is a legal character in a POSIX name, and a link named
  // `a\\b` that points out of the folder must be followed as one segment, never read as `a/b`; Windows takes both
  const segments = (q: string): string[] =>
    q.slice(path.parse(q).root.length).split(process.platform === "win32" ? /[\\/]/ : path.sep)
  const pending = segments(p)
  let at = path.parse(p).root,
    hops = 0
  while (pending.length) {
    const seg = pending.shift()
    if (!seg || seg === ".") continue
    if (seg === "..") {
      at = path.dirname(at)
      continue
    }
    const next = path.join(at, seg)
    let st: fs.Stats | null = null
    try {
      st = fs.lstatSync(next)
    } catch {
      /* absent: created where it is named */
    }
    if (!st?.isSymbolicLink()) {
      at = next
      continue
    }
    if (++hops > 40) return null
    const to = fs.readlinkSync(next)
    pending.unshift(...segments(to))
    if (path.isAbsolute(to)) at = path.parse(to).root
  }
  return at
}

/** Would a write to `rel` (root-relative, unnormalised — `a/../b` resolves through `a`) land outside `root`? */
export function escapes(root: string, rel: string): boolean {
  // the native realpath: on Windows the JS one leaves an 8.3 short name (RUNNER~1) that the walk below
  // expands, and the two spellings of one folder would read as different places; case is folded there too
  const canon = (q: string): string => {
    try {
      return fs.realpathSync.native(q)
    } catch {
      return fs.realpathSync(q)
    }
  }
  const fold = (q: string): string => (process.platform === "win32" ? q.toLowerCase() : q)
  const base = canon(root),
    to = landing(`${base}${path.sep}${rel}`)
  if (to === null) return true
  const r = path.relative(fold(base), fold(to))
  return r.startsWith("..") || path.isAbsolute(r)
}
