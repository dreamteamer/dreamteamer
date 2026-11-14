import type { AuthoredDescriptor } from "../types.ts"

export const isV2 = (doc: unknown): doc is AuthoredDescriptor =>
  !!doc && typeof doc === "object" && !Array.isArray(doc) && "fields" in doc
