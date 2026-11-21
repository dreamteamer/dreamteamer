import type { PackageJson } from "../../types.ts"
import type { SpecEntry } from "../types.ts"
import { refuse } from "../versions.ts"

/** What `npm view <spec>` is asked for: the manifest fields install and update read. */
export const NPM_VIEW_FIELDS = ["name", "version", "dreamteamer", "peerDependencies", "dependencies", "--json"]

/**
 * One `npm view <spec> … --json` run → the spec npm will be handed and its manifest, or a refusal naming why. Shared
 * by `readSpecManifest` (one synchronous view) and `updateCheck` (many at once), so both read the registry one way.
 */
export function parseNpmView(
  spec: string,
  { status, stdout, stderr }: { status: number | null; stdout: string; stderr: string }
): SpecEntry {
  if (status !== 0)
    throw refuse(
      `npm view ${spec} failed${
        stderr
          ? ` — ${
              stderr
                .trim()
                .split("\n")
                .filter(l => /E404|ETARGET|ENOTFOUND|EAI_AGAIN/.test(l))[0] ?? stderr.trim().split("\n")[0]
            }`
          : ""
      }`
    )
  let out: PackageJson | PackageJson[]
  try {
    out = JSON.parse(stdout)
  } catch {
    throw refuse(`npm view ${spec}: unreadable answer`)
  }
  const manifest = Array.isArray(out) ? out.at(-1) : out // a range answers with every match; the last is the newest
  if (!manifest?.name) throw refuse(`npm view ${spec}: no such package`)
  return { kind: "registry", spec: `${manifest.name}@${manifest.version}`, manifest }
}
