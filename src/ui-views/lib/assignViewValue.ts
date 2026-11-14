import { assignPath } from "./assignPath.ts"
import { parseViewValue } from "./parseViewValue.ts"

/** One dotted `key=value` write into a view: the value grammar, plus the one signal `assignPath`
 *  cannot recover from the parsed value — whether the operator quoted it. */
export function assignViewValue(view: Record<string, unknown>, key: string, raw: string | boolean): void {
  assignPath(view, key, parseViewValue(raw, key), typeof raw === "string" && raw.trim().startsWith('"'))
}
