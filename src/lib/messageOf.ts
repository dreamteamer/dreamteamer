/** the message of whatever was thrown */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
