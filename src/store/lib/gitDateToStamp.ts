/** Now, as the one canonical date-time spelling: local wall clock with its offset. */
/**
 * A `%aI` author date as a record's `created`: git prints a UTC date as `…Z` on some builds, and a
 * record's stamp is always offset-spelled, so the two spellings must read as the one value.
 */
export function gitDateToStamp(iso: string): string {
  return iso.replace(/Z$/, "+00:00")
}
