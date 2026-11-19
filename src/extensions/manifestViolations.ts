import type { PackageJson } from "../types.ts"

/**
 * What `dt check` holds every discovered package's manifest to, beyond the `dreamteamer` block: the
 * engine never under `dependencies` — npm nests a second engine there whenever the pin differs from the
 * workspace's, and a module reaching that copy disagrees with the engine the operator ran (D66).
 * `devDependencies` (a module's own tests) and `peerDependencies` are the two places it belongs.
 */
export function manifestViolations(
  pkg: PackageJson | null | undefined,
  file: string
): { file: string; message: string }[] {
  if (pkg?.dependencies && typeof pkg.dependencies === "object" && "dreamteamer" in pkg.dependencies) {
    return [
      {
        file,
        message: `${pkg.name ?? file} lists dreamteamer under dependencies — a second engine would be installed beside this one; move it to devDependencies or peerDependencies`,
      },
    ]
  }
  return []
}
