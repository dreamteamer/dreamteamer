// A view is an ordinary record conceptually (decision 49) but a SYSTEM-stored one, so it goes
// through saveUiView's compile gate rather than the record store. Without these verbs everything
// the Layout options panel does — columns, order, sort, layout, filter, nav — was click-only.

/**
 * View keys whose value is a LIST, so `display.list.columns=title,status` means what it says.
 *
 * ⚠ NAMED, not inferred, and that is the whole design: `options` is an open bag with no schema —
 * each layout declares its own keys and unknown ones ride through untouched — so nothing in the
 * runtime can tell a list key from a scalar one. Without this set the comma spelling every other
 * verb accepts for an array (`--tags a,b`) stored the literal string `"title,status"`, which the
 * surface reads with `Array.isArray` and therefore ignores: a view that looked configured, drew
 * the descriptor's `display.list.columns` instead, and reported nothing anywhere.
 *
 * `columns` is honoured by every list layout; `ref_fields` and `value_fields` are the diagram's
 * link-by pickers. `arrangement` is deliberately ABSENT — its elements are objects, so the JSON
 * form is its only honest spelling, and a comma split would quietly produce garbage.
 */
export const VIEW_LIST_OPTIONS = new Set([
  "display.list.columns",
  ...["list", "record"].flatMap(b => [`display.${b}.options.ref_fields`, `display.${b}.options.value_fields`]),
])

/**
 * ⚠ `module` is a VERB OPTION, exactly as it is on every other verb that takes one (see META_FLAGS)
 * — it says WHERE the source lands and is never a key of the view. Omitting it here is what wrote
 * `module: core` into the yaml as a field.
 */
export const VIEW_META_FLAGS = new Set(["id", "json", "force", "module"])
