import { readFileSync } from "node:fs"
import { asObject } from "./asObject.ts"
import { asString } from "./asString.ts"

/** this engine's version, from its package.json */
export function engineVersion(): string {
  const pkg = asObject(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")), "package.json")
  return asString(pkg.version, "package.json version")
}
