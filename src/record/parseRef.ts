/**
 * Split a reference into `{ collection, id }`, or `null` when it is not a reference shape.
 *
 * THE one place the boundary is decided. Everything that parses a reference — the store's write-time
 * check, `check`'s report, the extension's go-to-definition — goes through here, so a namespace can
 * never mean one thing on write and another on read.
 */
export function parseRef(ref: string, namespaces: string[] = []): { collection: string; id: string } | null {
  if (typeof ref !== "string" || !ref) return null
  for (const ns of namespaces) {
    if (!ref.startsWith(ns + "/")) continue
    const rest = ref.slice(ns.length + 1)
    const slash = rest.indexOf("/")
    // `health/doctors` alone names a COLLECTION, not a record — there is no id, so it is not a
    // reference. Falling through to the unnamespaced split would call it collection `health`,
    // which is the ambiguity this module refuses everywhere else.
    if (slash < 1 || slash === rest.length - 1) return null
    return { collection: `${ns}/${rest.slice(0, slash)}`, id: rest.slice(slash + 1) }
  }
  const slash = ref.indexOf("/")
  if (slash < 1 || slash === ref.length - 1) return null
  return { collection: ref.slice(0, slash), id: ref.slice(slash + 1) }
}
