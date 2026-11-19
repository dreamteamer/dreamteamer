import fs from "node:fs"

export const isLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
