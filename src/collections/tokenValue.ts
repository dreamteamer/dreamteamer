import { UNKNOWN_TOKEN } from "./UNKNOWN_TOKEN.ts"
import { TOKEN } from "../record/filter.ts"

const pad = (n: number): string => String(n).padStart(2, "0")

/** The value a token stands for at `at` (default: now), or undefined for a string that is not a token. */
export function tokenValue(value: unknown, at: Date = new Date()): string | typeof UNKNOWN_TOKEN | undefined {
  if (typeof value !== "string" || !TOKEN.test(value)) return undefined
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  if (value === "$today") return day
  if (value === "$now") {
    const mins = -at.getTimezoneOffset()
    const abs = Math.abs(mins)
    return `${day}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}${mins < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  }
  return UNKNOWN_TOKEN
}
