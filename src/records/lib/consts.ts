export const UNKNOWN_TOKEN = Symbol("unknown token")

/** `list` flags that are options, not `field=value` shorthand filters. */
export const LIST_META_FLAGS = new Set(["json", "filter", "where", "sort"])
