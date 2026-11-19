import { bodyFieldOf } from "./descriptor.ts"
import type { Descriptor } from "../types.ts"

export function bodyField(d: Descriptor): string | undefined {
  return bodyFieldOf(d)
}
