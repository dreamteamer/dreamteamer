import { readManifest } from "./runtime.ts"

/** What compile recorded for the exports manifest (cr-dt-004): this workspace's package name and data folder. */
export function exportsFacts(root: string): { own: string | null; data: string } {
  const m = readManifest(root)
  return { own: m?.package ?? null, data: m?.data_path ?? "data" }
}
