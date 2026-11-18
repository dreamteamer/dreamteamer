// The nav document — `nav.yaml` at the workspace root (cr-dt-008, design §3). One tracked file says how
// the left nav draws: folders, namespace folders and rows in the operator's order, plus the rows not
// drawn at all. Every host (the editor, dt web, install's merge) reads and writes it through these
// functions, so there is one grammar and one writer.
//
// Record layer: a file under the root, parsed and validated against names the caller passes in. It
// never learns what a module or a package is — which module a fragment comes from, and whether it may
// place a name, is judged in workspace/navFragments.ts.
import fs from "node:fs"
import path from "node:path"
import type { NavDoc, NavEntry, NavWarning } from "../types.ts"
import { load, dump } from "../lib/yaml.ts"
import { atomicWrite } from "../lib/atomicWrite.ts"

export const NAV_FILE = "nav.yaml"
const HEADER = "# The left nav of this workspace. Drag and drop writes this file; so may you."

export class NavDocError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NavDocError"
  }
}

type NavKind = "collection" | "folder" | "namespace"
/** An entry as it may arrive from a hand-edited file: any of the four shapes, or none of them. */
type LooseEntry = NavEntry | Record<string, unknown>
interface Folded {
  folder: string
  icon?: string
  hidden?: boolean
  items?: LooseEntry[]
}
interface Spaced {
  namespace: string
  icon?: string
  hidden?: boolean
  items?: LooseEntry[]
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
/** 'collection' · 'folder' · 'namespace', or null for an entry of none of the four shapes. */
function kindOf(e: unknown): NavKind | null {
  if (typeof e === "string") return "collection"
  if (!isObject(e)) return null
  if (typeof e.collection === "string") return "collection"
  if (typeof e.folder === "string") return "folder"
  if (typeof e.namespace === "string") return "namespace"
  return null
}
const nameOf = (e: unknown): string => (typeof e === "string" ? e : String((e as { collection: string }).collection))

/** Every entry of a tree level and the levels inside it, depth first, with its kind. */
function eachEntry(items: unknown, visit: (e: LooseEntry, kind: NavKind | null) => void): void {
  if (!Array.isArray(items)) return
  for (const e of items as LooseEntry[]) {
    const kind = kindOf(e)
    visit(e, kind)
    if (kind === "folder" || kind === "namespace") eachEntry((e as Folded | Spaced).items, visit)
  }
}

/** The text of a nav.yaml, as a NavDoc. Pure. An empty file, or one with neither key, is an empty document. */
export function parseNavDoc(text: string): NavDoc {
  let raw: unknown
  try {
    raw = load(String(text))
  } catch (e) {
    throw new NavDocError(`nav.yaml is not valid YAML — ${(e as Error).message}`)
  }
  if (raw === undefined || raw === null) return { tree: [], hidden: [] }
  if (!isObject(raw)) throw new NavDocError("nav.yaml is not a mapping")
  const tree = raw.tree ?? []
  const hidden = raw.hidden ?? []
  if (!Array.isArray(tree)) throw new NavDocError("nav.yaml: tree must be a list")
  if (!Array.isArray(hidden)) throw new NavDocError("nav.yaml: hidden must be a list")
  return { tree, hidden }
}

/** A NavDoc as the text of a nav.yaml: the header line, `tree`, and `hidden` only when it holds a name. Pure. */
export function serializeNavDoc(doc: NavDoc): string {
  const body: Partial<NavDoc> = { tree: doc.tree }
  if (doc.hidden.length) body.hidden = doc.hidden
  return `${HEADER}\n${dump(body).replace(/\n+$/, "")}\n`
}

/** `<root>/nav.yaml` parsed, or null when there is none. Any other read failure is a NavDocError. */
export function readNavDoc(root: string): NavDoc | null {
  let text: string
  try {
    text = fs.readFileSync(path.join(root, NAV_FILE), "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new NavDocError(`nav.yaml could not be read — ${(e as Error).message}`)
  }
  return parseNavDoc(text)
}

/** The one writer every host uses: the whole document, atomically. False when the bytes were already there. */
export function writeNavDoc(root: string, doc: NavDoc): boolean {
  return atomicWrite(path.join(root, NAV_FILE), serializeNavDoc(doc))
}

/** What `dt check` reports about a document: names that resolve to nothing, names listed twice. Never throws. */
export function validateNavDoc(
  doc: NavDoc,
  { collections, namespaces = [] }: { collections: Set<string>; namespaces?: string[] }
): NavWarning[] {
  const declared = new Set(namespaces)
  const warnings: NavWarning[] = []
  const warn = (warning: string) => warnings.push({ warning })
  const seen = new Set<string>()
  const twice = new Set<string>()
  const count = (name: string) => {
    if (seen.has(name) && !twice.has(name)) {
      twice.add(name)
      warn(`"${name}" is listed twice — it draws at its first place`)
    }
    seen.add(name)
  }
  eachEntry(doc.tree, (e, kind) => {
    if (kind === "collection") {
      if (!collections.has(nameOf(e))) warn(`unknown collection "${nameOf(e)}"`)
      count(nameOf(e))
    } else if (kind === "namespace") {
      const ns = (e as Spaced).namespace
      if (!declared.has(ns)) warn(`unknown namespace "${ns}"`)
      count(ns)
    } else if (kind === "folder") {
      if (!Array.isArray((e as Folded).items)) warn(`folder "${(e as Folded).folder}" has no items list`)
    } else warn(`${JSON.stringify(e)} is not a collection, a folder or a namespace`)
  })
  for (const name of doc.hidden as unknown[]) {
    if (typeof name !== "string") {
      warn(`hidden holds ${JSON.stringify(name)}, which is not a name`)
      continue
    }
    // a hidden name is a row or a whole namespace folder
    if (!collections.has(name) && !declared.has(name)) warn(`unknown collection "${name}"`)
    count(name)
  }
  return warnings
}

/** The names of one kind of entry in the tree, at any depth, plus every hidden name. */
function namesIn(doc: NavDoc, wanted: "collection" | "namespace"): Set<string> {
  const out = new Set<string>()
  eachEntry(doc.tree, (e, kind) => {
    if (kind === wanted) out.add(kind === "collection" ? nameOf(e) : (e as Spaced).namespace)
  })
  for (const name of doc.hidden as unknown[]) if (typeof name === "string") out.add(name)
  return out
}

/**
 * Every collection the document places: named in the tree at any depth, or hidden. A namespace entry
 * places nothing by itself (design §3 rule 3) — its collections are placed only by name.
 */
export const placedNames = (doc: NavDoc): Set<string> => namesIn(doc, "collection")

/** A folder's or namespace's icon and hidden flag, as the merge carries them over. */
const decor = (e: Folded | Spaced) => ({
  ...(e.icon != null ? { icon: e.icon } : {}),
  ...(e.hidden === true ? { hidden: true } : {}),
})

/**
 * A module's fragment merged into the document: it only ever ADDS what the document does not place yet,
 * and never moves what is placed. Pure — neither input is mutated, and when nothing is placed the SAME
 * `doc` object comes back, so a caller can tell "nothing to write" by identity. The fragment's `hidden`
 * is ignored: a module never hides a row.
 *
 * Per fragment level, against the document level at the same depth: a row not placed is appended; a
 * folder merges into the same-label folder AT THE SAME LEVEL, else into a new one appended only when it
 * placed something; a namespace merges into the same namespace's entry at the same level, else — when
 * the document names that namespace nowhere — into a new entry; named at another level, nothing is
 * created and its rows stay unplaced (the drawing puts them inside that namespace's folder).
 */
export function mergeFragment(
  doc: NavDoc,
  fragment: NavDoc,
  { placed = placedNames(doc) }: { placed?: Set<string> } = {}
): { doc: NavDoc; placedNow: string[] } {
  const taken = new Set(placed)
  const named = namesIn(doc, "namespace")
  const placedNow: string[] = []
  // one tree level: `level` is copied on its first change, so an untouched level comes back as itself
  const mergeLevel = (level: LooseEntry[], items: unknown): LooseEntry[] => {
    let out = level
    const own = () => {
      if (out === level) out = [...level]
      return out
    }
    const into = (i: number, e: Folded | Spaced) => {
      // merge e's items into out[i]'s
      const target = out[i] as Folded | Spaced
      const current = Array.isArray(target.items) ? target.items : []
      const merged = mergeLevel(current, e.items)
      if (merged !== current) own()[i] = { ...target, items: merged } as LooseEntry
    }
    for (const f of Array.isArray(items) ? (items as LooseEntry[]) : []) {
      const kind = kindOf(f)
      if (kind === "collection") {
        const c = nameOf(f)
        if (taken.has(c)) continue
        taken.add(c)
        placedNow.push(c)
        const icon = typeof f === "string" ? undefined : (f as { icon?: string }).icon
        own().push(icon == null ? c : { collection: c, icon })
      } else if (kind === "folder") {
        const ff = f as Folded
        const i = out.findIndex(e => kindOf(e) === "folder" && (e as Folded).folder === ff.folder)
        if (i >= 0) {
          into(i, ff)
          continue
        }
        const merged = mergeLevel([], ff.items)
        if (merged.length) own().push({ folder: ff.folder, ...decor(ff), items: merged } as LooseEntry)
      } else if (kind === "namespace") {
        const nf = f as Spaced
        const i = out.findIndex(e => kindOf(e) === "namespace" && (e as Spaced).namespace === nf.namespace)
        if (i >= 0) {
          into(i, nf)
          continue
        }
        if (named.has(nf.namespace)) continue // named at another level: its rows draw inside it
        const merged = mergeLevel([], nf.items)
        if (!merged.length && nf.items?.length) continue
        named.add(nf.namespace)
        own().push({ namespace: nf.namespace, ...decor(nf), ...(merged.length ? { items: merged } : {}) } as LooseEntry)
      }
    }
    return out
  }
  const merged = mergeLevel(doc.tree, fragment.tree)
  return {
    doc: merged === doc.tree ? doc : { tree: merged as NavEntry[], hidden: [...doc.hidden] },
    placedNow,
  }
}
