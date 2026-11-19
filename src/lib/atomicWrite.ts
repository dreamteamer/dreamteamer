import fs from "node:fs"

export function atomicWrite(file: string, content: string | Buffer): boolean {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return false // true no-op
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
  return true
}
