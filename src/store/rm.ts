import { rmSync } from "node:fs"
import { basename, dirname, relative } from "node:path"
import { DtError } from "../lib/DtError.ts"
import { listFiles } from "../lib/listFiles.ts"
import type { Model } from "../types/Model.ts"
import { locate } from "./locate.ts"
import { referrers } from "./referrers.ts"
import { entryOf, tail } from "./tail.ts"

/** Remove a record. Refuses when other records point at it, or when its folder holds other records — unless forced. */
export function rm(model: Model, ref: string, force = false): string {
  const { c, id, path } = locate(model, ref)
  const full = `${c.name}/${id}`
  const folder = c.storage.shape === "folder"
  if (!force) {
    const by = referrers(model, full)
    if (by.length)
      throw new DtError(
        `${full} is referenced by ${by.length} record(s) — nothing removed; fix them, or pass --force:\n  ${by.join("\n  ")}`,
      )
    const all = Object.values(model.collections).filter((t) => t.storage.format !== "binary")
    const inside = folder
      ? listFiles(dirname(path)).filter(
          (t) =>
            t !== path &&
            all.some((o) => (o.storage.shape === "folder" ? basename(t) === entryOf(o) : t.endsWith(tail(o)))),
        )
      : []
    if (inside.length)
      throw new DtError(
        `${full} holds ${inside.length} other record(s) inside its folder — nothing removed; move them, or pass --force:\n  ${inside.map((t) => relative(model.root, t)).join("\n  ")}`,
      )
  }
  rmSync(folder ? dirname(path) : path, { recursive: true })
  return full
}
