import type { AuthoredDescriptor } from "../../types.ts"
import { V2_KEYS } from "../consts.ts"

const STORAGE_KEYS = ["path", "format", "shape", "entry", "suffix", "under", "max_bytes", "accept", "owner"]

const DISPLAY_BLOCKS: Record<string, string[]> = {
  nav: ["icon", "order", "section"],
  list: ["layout", "columns", "sort", "options"],
  record: ["layout", "subtitle", "badge", "color_by", "options"],
  form: ["sections"],
}

/** Shape errors that need no other descriptor: closed keys, v1 keys, storage, id, display layout. */
export function shapeErrors(doc: AuthoredDescriptor): string[] {
  const errors: string[] = []
  for (const k of Object.keys(doc)) {
    if (V2_KEYS.includes(k)) continue
    errors.push(`unknown key \`${k}\` — a descriptor's keys are ${V2_KEYS.join(" · ")}`)
  }
  if (doc.overlay !== undefined && doc.overlay !== true)
    errors.push("`overlay` is `true` or absent — the base is the one source of this collection without it")
  const s = doc.storage ?? {}
  for (const k of Object.keys(s)) {
    if (STORAGE_KEYS.includes(k)) continue
    errors.push(`unknown key \`storage.${k}\` — storage keys are ${STORAGE_KEYS.join(" · ")}`)
  }
  if (s.format !== undefined && !["md", "yaml", "json", "binary"].includes(s.format))
    errors.push("`storage.format` is md · yaml · json · binary")
  if (s.shape !== undefined && !["file", "folder"].includes(s.shape)) errors.push("`storage.shape` is file · folder")
  if (s.owner !== undefined && !["module", "workspace"].includes(s.owner))
    errors.push(
      "`storage.owner` is module · workspace — whose repo holds the records: the shipping module's clone, or this workspace (the default)"
    )
  if (s.under !== undefined) {
    const u = s.under
    if (!u || typeof u !== "object") errors.push("`storage.under` is { parent, subfolder }")
    else {
      for (const k of Object.keys(u))
        if (!["parent", "subfolder", "id"].includes(k))
          errors.push(`unknown key \`storage.under.${k}\` — under takes parent · subfolder · id`)
      if (!u.parent || !u.subfolder)
        errors.push("`storage.under` needs both `parent` (a reference field of this collection) and `subfolder`")
      if (u.id !== undefined && !["independent", "nested"].includes(u.id))
        errors.push(
          "`storage.under.id` is independent (the id survives a move) or nested (the id begins with the parent's)"
        )
    }
  }
  if (doc.ids !== undefined) {
    for (const k of Object.keys(doc.ids))
      if (!["from", "pattern"].includes(k)) errors.push(`unknown key \`ids.${k}\` — ids takes from · pattern`)
  }
  if (doc.display !== undefined) {
    for (const [b, v] of Object.entries(doc.display)) {
      if (!DISPLAY_BLOCKS[b]) {
        errors.push(`unknown key \`display.${b}\` — display has ${Object.keys(DISPLAY_BLOCKS).join(" · ")}`)
        continue
      }
      for (const k of Object.keys(v ?? {}))
        if (!DISPLAY_BLOCKS[b].includes(k))
          errors.push(`unknown key \`display.${b}.${k}\` — ${b} has ${DISPLAY_BLOCKS[b].join(" · ")}`)
    }
  }
  if (doc.constraints !== undefined && !Array.isArray(doc.constraints))
    errors.push("`constraints` is a list of JSON Schema combinators")
  return errors
}
