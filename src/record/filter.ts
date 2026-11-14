// ---- value tokens ------------------------------------------------------------------
// A filter value is a literal or one of VALUE_TOKENS, resolved when the filter is evaluated against
// the evaluating machine's clock and zone, so a saved view "due before today" stays true tomorrow.
// `$today` is the local calendar date (the shape a `date` field holds); `$now` is the local instant
// with its offset (the shape a `datetime` field holds). A token is the WHOLE value: `$100` is a
// literal, `$yesterday` is an unknown token. compile and `--where` refuse an unknown token through
// `unknownTokens`; at evaluation one narrows to nothing, the same posture as an unknown operator.
export const VALUE_TOKENS = ["$today", "$now"]

export const TOKEN = /^\$[A-Za-z_]\w*$/
