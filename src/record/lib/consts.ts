/**
 * `date:HH-mm` on a date-time field is how an id embeds a start time. A date or date-time STRING
 * renders as written, in its own offset (`2026-07-28T23:30:00+03:00` is 23:30 on the 28th on every
 * machine), so an id is the same wherever it is generated. Only `created`/`now` read the machine's
 * zone. Tokens are replaced longest-first so `MM` (month) can't eat the `M` of a minute pattern.
 */
export const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/
