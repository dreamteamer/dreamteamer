import { readManifest } from "./runtime.ts"

/**
 * What compile recorded for the exports manifest (cr-dt-004): this workspace's package name and data
 * folder, and per layer `{ name, root, data, package, reads, narrowed }` — `layers: null` from a runtime
 * older than them, which a caller reads as "nothing is known".
 */
export function exportsFacts(root: string): {
  own: string | null
  data: string
  layers:
    { name: string; root: string; data: string; package: string | null; reads: string[]; narrowed: boolean }[] | null
} {
  const m = readManifest(root)
  return { own: m?.package ?? null, data: m?.data_path ?? "data", layers: m?.layers ?? null }
}
