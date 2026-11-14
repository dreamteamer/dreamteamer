/**
 * Why `p` is not an acceptable `under.subfolder`, as a sentence — or null. A relative subfolder of the
 * parent record's folder: no absolute path, no traversal, no empty segment, no backslash (the same
 * alphabet `assertSafeId` holds ids to, because this path is joined onto the filesystem too).
 */
export function subpathProblem(p: unknown): string | null {
  if (typeof p !== "string" || p === "")
    return "must be a relative folder path inside the parent record's folder (e.g. `meetings`)"
  if (p.startsWith("/") || p.includes("\\"))
    return `"${p}" must be relative to the parent record's folder — no leading slash, no backslashes`
  if (p.split("/").some(s => s === "" || s === "." || s === ".."))
    return `"${p}" may not contain "." or ".." segments or an empty one`
  return null
}
