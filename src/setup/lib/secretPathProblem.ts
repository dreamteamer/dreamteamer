import fs from "node:fs"

/** A secret-path input's file: it must exist, be a file, and (posix) be readable by its owner only. The engine never reads it. */
export function secretPathProblem(value: string): string | null {
  let st
  try {
    st = fs.statSync(value)
  } catch {
    return `${value}: no such file`
  }
  if (!st.isFile()) return `${value}: not a file`
  if (process.platform !== "win32" && st.mode & 0o077) return `${value} is readable by other users — chmod 600 ${value}`
  return null
}
