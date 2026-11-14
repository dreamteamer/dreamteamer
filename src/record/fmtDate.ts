import { asDate } from "./template.ts"
import { WALL_CLOCK } from "./consts.ts"

export function fmtDate(v: unknown, fmt: string): string {
  const pad = (n: number): string => String(n).padStart(2, "0")
  const m = typeof v === "string" ? WALL_CLOCK.exec(v) : null
  const d = m ? null : asDate(v)
  const tokens: Record<string, string> = m
    ? { YYYY: m[1], MM: m[2], DD: m[3], HH: m[4] ?? "00", mm: m[5] ?? "00", ss: m[6] ?? "00" }
    : {
        YYYY: String(d.getFullYear()),
        MM: pad(d.getMonth() + 1),
        DD: pad(d.getDate()),
        HH: pad(d.getHours()),
        mm: pad(d.getMinutes()),
        ss: pad(d.getSeconds()),
      }
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, t => tokens[t])
}
