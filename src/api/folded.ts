import { DtError } from "../lib/DtError.ts"

/**
 * Run a write, and when it is refused for reasons, put each reason into the message: a host forwards only the
 * message (`{ error }`), so the reasons would otherwise be lost.
 */
export function folded<T>(write: () => T): T {
  try {
    return write()
  } catch (e) {
    if (!(e instanceof DtError) || !e.issues.length) throw e
    throw new DtError(`${e.message}: ${e.issues.map((t) => `${t.where} ${t.message}`).join("; ")}`, e.issues)
  }
}
