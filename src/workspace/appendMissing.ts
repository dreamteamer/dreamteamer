import fs from "node:fs"

export function appendMissing(file: string, block: string): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const missing = block.split("\n").filter(l => l && !existing.split("\n").includes(l))
  if (missing.length) fs.writeFileSync(file, (existing ? existing.trimEnd() + "\n" : "") + missing.join("\n") + "\n")
}
