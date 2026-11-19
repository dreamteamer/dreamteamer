/** Render ONE template, or throw if a field it names is missing. The list form loops over this. */
export type OnFallback = (e: { field: string; value: string; id: string }) => void
