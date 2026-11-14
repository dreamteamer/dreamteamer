import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { EnvRefusal } from "./env-write.ts"

/** `sha256:<hex>` of a regular file, `absent` when there is none; a symlink or a non-file is refused. */
export function fingerprint(file: string): string {
  let st
  try {
    st = fs.lstatSync(file)
  } catch (error) {
    if (error.code === "ENOENT") return "absent"
    throw error
  }
  if (st.isSymbolicLink())
    throw new EnvRefusal(
      "symlink",
      `${path.basename(file)} is a symlink — a symlinked file is never written; replace the link with a regular file first`
    )
  if (!st.isFile()) throw new EnvRefusal("not-file", `${path.basename(file)} is not a regular file`)
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`
}
