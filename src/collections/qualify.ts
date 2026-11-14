/** `health` + `doctors` → `health/doctors`; the default namespace (empty) → `doctors`. */
export function qualify(namespace: string | null | undefined, name: string): string {
  const ns = String(namespace ?? "").replace(/^\/+|\/+$/g, "")
  return ns ? `${ns}/${name}` : String(name)
}
