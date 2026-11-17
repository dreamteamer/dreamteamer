import { DtError } from "../lib/DtError.ts"

/** An id is a relative path inside its collection's folder: no empty, `.` or `..` segment, no leading slash, no control character. */
export function checkId(id: string): void {
  if (
    typeof id !== "string" ||
    !id ||
    /[\\\u0000-\u001f]/.test(id) ||
    id.split("/").some((t) => !t || t === "." || t === "..")
  )
    throw new DtError(
      `invalid id "${id ?? ""}" — an id is a relative path with no empty, "." or ".." segment and no leading slash`,
    )
}
