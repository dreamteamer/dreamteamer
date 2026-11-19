export const fmtCell = (v: unknown): string => (v === undefined ? "-" : Array.isArray(v) ? v.join(",") : String(v))
