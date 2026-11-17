function pad(n: number) {
  return String(n).padStart(2, "0")
}

/** local time with its offset, to the second: 2026-12-01T10:00:00+02:00 */
export function stamp(d = new Date()): string {
  const off = -d.getTimezoneOffset()
  const a = Math.abs(off)
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return `${day}T${time}${off < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}
