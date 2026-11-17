import type { Issue } from "../types/Issue.ts"
import { DtError } from "./DtError.ts"

/** what `read` returns; when it refuses the input with a DtError, `fallback`, and the refusal as an error at `where` */
export function readOr<T>(issues: Issue[], where: string, read: () => T, fallback: T): T {
  try {
    return read()
  } catch (e) {
    if (!(e instanceof DtError)) throw e
    issues.push({ severity: "error", where, message: e.message })
    return fallback
  }
}
