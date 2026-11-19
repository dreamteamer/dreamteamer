interface Version {
  core: [number, number, number]
  pre: string[] // the prerelease identifiers; empty for a release
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

const parse = (v: string): Version | null => {
  const m = VERSION.exec(String(v).trim())
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] } : null
}

const cmpIdent = (a: string, b: string): number => {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Number(a) - Number(b)
  if (an !== bn) return an ? -1 : 1 // numeric identifiers sort below alphanumeric ones
  return a < b ? -1 : a > b ? 1 : 0
}

// semver precedence: the core first; then a prerelease sorts BELOW its release (0.51.0-next.1 < 0.51.0)
// and two prereleases compare identifier by identifier, the shorter list first when one prefixes the other
const cmp = (a: Version, b: Version): number => {
  const core = a.core[0] - b.core[0] || a.core[1] - b.core[1] || a.core[2] - b.core[2]
  if (core || (!a.pre.length && !b.pre.length)) return core
  if (!a.pre.length) return 1
  if (!b.pre.length) return -1
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const c = cmpIdent(a.pre[i], b.pre[i])
    if (c) return c
  }
  return a.pre.length - b.pre.length
}

/**
 * true = in range, false = out of range, null = version or range not understood.
 *
 * A prerelease is compared by precedence, unlike npm, which keeps a prerelease out of every range whose
 * bound has a different core. The version tested here is mostly THIS engine's, against a module's floor:
 * an engine published as `0.50.1-next.<stamp>` was cut after 0.50.0 and carries what 0.50.0 does, so
 * `>=0.50.0` must hold — read npm's way, every floor would refuse it, and `dreamteamer/testing`'s
 * engine gate would skip the very suites a next engine is published to run. A floor may name a
 * prerelease too (`>=0.50.1-next.<stamp>`), which is how a module's own next build targets that engine.
 */
export function satisfies(version: string, range: string): boolean | null {
  const v = parse(version)
  if (!v) return null
  const r = String(range).trim()
  if (r === "*") return true
  const m = /^(>=|\^|~)?(\S+)$/.exec(r)
  const base = m && parse(m[2])
  if (!m || !base) return null
  const [major, minor] = base.core
  switch (m[1]) {
    case ">=":
      return cmp(v, base) >= 0
    case "^": // same major, >= base; zero-major pins the minor too (npm's ^0.x rule)
      if (cmp(v, base) < 0) return false
      return major === 0 ? v.core[0] === 0 && v.core[1] === minor : v.core[0] === major
    case "~": // same major.minor, >= base
      return cmp(v, base) >= 0 && v.core[0] === major && v.core[1] === minor
    default:
      return cmp(v, base) === 0 // exact
  }
}
