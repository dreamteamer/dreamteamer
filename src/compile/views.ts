import { BUILTIN_FIELDS } from "./consts.ts"

export const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

export const has = (fields: Record<string, unknown>, f: string): boolean => BUILTIN_FIELDS.includes(f) || f in fields
