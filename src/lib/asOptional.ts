/** undefined for a value that is absent or null; anything else must pass `read` */
export function asOptional<T>(v: unknown, where: string, read: (x: unknown, where: string) => T): T | undefined {
  return v === undefined || v === null ? undefined : read(v, where)
}
