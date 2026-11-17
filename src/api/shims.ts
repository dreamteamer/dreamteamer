// The small names of the released engine's API that are one call into this engine, or a constant.
import { writeSync } from "node:fs"
import { parse } from "yaml"
import { mapOf } from "../lib/mapOf.ts"
import { buildModel } from "../model/buildModel.ts"
import { systemModule } from "../model/systemModule.ts"
import { accessors, type Released } from "./accessors.ts"
import { namespacesOf } from "./namespaces.ts"
import { staleness } from "./readManifest.ts"
import { Store } from "./Store.ts"

/** the released engine's version this adapter answers for: its system module's, which module floors are checked against */
function engineVersion(): string {
  return systemModule().version
}

/** the namespaces declared in a workspace, longest first */
function namespaces(root: string): string[] {
  return namespacesOf(buildModel(root))
}

/** every collection's projected descriptor, by name */
function loadDescriptors(root: string): Map<string, Released> {
  return new Store({ root }).descriptors
}

/** the body field's name, or null */
function bodyField(d: Released): string | null {
  return accessors.bodyFieldOf(d) ?? null
}

/** a record's fields from its text, in its collection's format; a Markdown body lands in the body field */
function parseRecordText(text: string, d: Released, bf = bodyField(d)): Record<string, unknown> {
  const format = accessors.storageOf(d).format
  if (format === "json") return mapOf(JSON.parse(text))
  if (format !== "md") return mapOf(parse(text))
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const fields = mapOf(m ? parse(m[1]) : null)
  const body = m ? m[2] : text
  if (bf && body.trim()) fields[bf] = body
  return fields
}

/** say on stderr that the workspace has no compiled runtime, when it has none */
function warnIfStale(root: string) {
  const s = staleness(root)
  if (!s.compiled) console.warn(`⚠ ${s.message}`)
  return s
}

/** write a line to a file descriptor whole, even when it is a pipe that takes it in parts */
function emit(text: string, fd = 1) {
  const buf = Buffer.from(text + "\n")
  for (let off = 0; off < buf.length;)
    try {
      off += writeSync(fd, buf, off, buf.length - off)
    } catch (e) {
      if (mapOf(e).code !== "EAGAIN") throw e
    }
}

/** the shims, by the names the released engine's API gives them */
export const shims = { engineVersion, namespaces, loadDescriptors, bodyField, parseRecordText, warnIfStale, emit }
