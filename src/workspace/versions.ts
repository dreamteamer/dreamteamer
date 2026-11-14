import path from "node:path"
import fs from "node:fs"
import { EXIT } from "./setup.ts"

/** Numeric major.minor.patch order; a prerelease sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split(/[-+]/)[0].split(".").map(Number),
    pb = String(b).split(/[-+]/)[0].split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return (a.includes("-") ? 0 : 1) - (b.includes("-") ? 0 : 1)
}

export class InstallRefusal extends Error {
  code: number
  constructor(m: string) {
    super(m)
    this.code = EXIT.failed
  }
}

export const refuse = (m: string): InstallRefusal => new InstallRefusal(m)

export const splitSpec = (spec: string): { name: string; version: string | null } => {
  const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@")
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: null }
}

export const isPathSpec = (spec: string, cwd: string): boolean =>
  (spec.startsWith(".") || path.isAbsolute(spec) || spec.startsWith("file:")) &&
  fs.existsSync(path.resolve(cwd, spec.replace(/^file:/, "")))
