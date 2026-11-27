import path from "node:path"
import Ajv from "ajv"
import addFormats from "ajv-formats"
import fs from "node:fs"
import { isStale } from "./isStale.ts"
import { symlinkedChildRoots } from "./symlinkedChildRoots.ts"
import { collectRefFields } from "../record/collectRefFields.ts"
import { bodyFieldOf, fieldsOf, idsOf, jsonSchemaOf, unresolvedPeersOf } from "../record/descriptor.ts"
import { expectedMirrors } from "../record/expectedMirrors.ts"
import { sees } from "../record/sees.ts"
import { valuesAt } from "../record/valuesAt.ts"
import { EXPORTS_FILE } from "../record/consts.ts"
import { exportsContext } from "../record/exportsContext.ts"
import { idFromRecordPath } from "../record/idFromRecordPath.ts"
import { outsideRefs } from "../record/outsideRefs.ts"
import { ownerIdOf } from "../record/ownerIdOf.ts"
import { parseRef } from "../record/parseRef.ts"
import { placedRecords } from "../record/placedRecords.ts"
import { placementOf } from "../record/placement.ts"
import { readExports } from "../record/readExports.ts"
import { fmtAjvError, parseRecord, patternRe, unknownFields } from "../record/records.ts"
import { MAX_RECORD_BYTES } from "../record/consts.ts"
import { regenerate } from "../record/regenerate.ts"
import { relationsOf } from "../record/relationsOf.ts"
import { storageOf } from "../record/storageOf.ts"
import type { ExportRefs, Relation } from "../record/types.ts"
import { walk } from "../lib/walk.ts"
import { exportsFacts } from "../runtime/exportsFacts.ts"
import { loadDescriptors } from "../runtime/loadDescriptors.ts"
import { namespaces as compiledNamespaces, runtimeDir } from "../runtime/runtime.ts"
import { NO_RUNTIME } from "../runtime/consts.ts"
import type { Descriptor } from "../types.ts"
import { readNavDoc, validateNavDoc, NavDocError } from "../record/nav.ts"

export function check(
  { root }: { root: string; pkg?: unknown },
  {
    extra = [],
    strictExport = false,
  }: { extra?: { file: string; msg: string; warning?: true }[]; strictExport?: boolean } = {}
): 0 | 1 | 2 {
  const RUNTIME = runtimeDir(root)
  const rel = (p: string): string => path.relative(root, p)

  // useDefaults matches the STORE's validator (review finding 11: the two paths could
  // reach different verdicts on identical bytes). check never writes — the defaults
  // materialize into the in-memory copy only.
  const ajv = new (Ajv as unknown as typeof Ajv.default)({
    allErrors: true,
    strict: false,
    useDefaults: true,
    coerceTypes: "array",
  })
  ;(addFormats as unknown as typeof addFormats.default)(ajv)
  ajv.addFormat("markdown", true) // rich-text marker, not a syntax to validate
  ajv.addFormat("html", true) // likewise: markup is stored as written, never validated

  const descriptors = loadDescriptors(root)
  if (!descriptors) {
    console.error(`✖ ${NO_RUNTIME}`)
    return 2
  }
  // Off the manifest, like the descriptors themselves — `check` is in the record layer and must not
  // learn what a workspace package.json is (see the split in CLAUDE.md).
  const namespaces = compiledNamespaces(root)

  // index all records: collection -> Map<id, filePath>
  const index = new Map()
  // placed collections only: id -> the parent id its file was FOUND under (null = the fallback root)
  const observed = new Map()
  const strays = []
  // declared here rather than beside the validation pass: indexing can itself produce a
  // finding (an unreachable data root, below) before a single record is read.
  const violations: { file: string; msg: string }[] = []
  const dirOf = (d: Descriptor): string => path.resolve(storageOf(d).runtime ? RUNTIME : root, storageOf(d).path) // resolve: an env-pointed root is absolute
  // per indexed file: the repo that holds it (mirrors are expected per repo)
  const fileRepo = new Map<string, string>()
  const notes = new Map() // key -> note, printed once
  for (const [name, d] of descriptors) {
    const ids = new Map()
    index.set(name, ids)
    const claim = (id: string, f: string, repo: string): boolean => {
      if (ids.has(id)) {
        violations.push({
          file: rel(f),
          msg: `collection "${name}" holds the id "${id}" twice — ${rel(ids.get(id))} and ${rel(f)}. Remove one.`,
        })
        return false
      }
      ids.set(id, f)
      fileRepo.set(f, repo)
      return true
    }
    // An env-pointed root this machine cannot render is the normal state of a per-machine
    // collection elsewhere — said once, and not read: a literal `${env:…}`
    // folder is never looked at, and a reference into the collection is not a finding here.
    if (storageOf(d).unavailable) {
      notes.set(
        `collection:${name}`,
        `⚠ collection ${name}: ${storageOf(d).unavailable} — its records are not read on this machine, and references into it are not checked`
      )
      continue
    }
    // runtime-based (knowhow/meta) collections are read from the COMPILED runtime —
    // their sources may live in any module; .dreamteamer is the merged read surface
    const dir = dirOf(d)
    // An unreachable data ROOT is a finding, not a skip: a collection whose module clone is
    // missing otherwise reports zero records and a clean check — a silent success. An EMPTY
    // directory stays fine (a module with no records yet is normal); only a missing owning
    // repo counts.
    const repoRoot = path.resolve(root, storageOf(d).repo)
    if (!fs.existsSync(dir) && storageOf(d).repo !== "." && !fs.existsSync(repoRoot)) {
      violations.push({
        file: storageOf(d).path,
        msg: `collection "${name}" is owned by ${storageOf(d).repo}, which is not present — every record in it is unreadable`,
      })
      continue
    }
    const under = placementOf(d)
    if (under) {
      // ONE logical collection across the fallback root and every parent folder — the same walk
      // the store indexes with (src/placement.ts), so the two cannot disagree about which files
      // are records. The first file to claim an id keeps it; every later one is a violation,
      // because a `get` that silently answered from whichever folder sorted later is the
      // failure this report exists to make visible.
      const seen = new Map()
      observed.set(name, seen)
      const parentDir = dirOf(descriptors.get(under.collection))
      // a child root that is (or sits behind) a symlink is not read — whatever it points at is not
      // this parent's folder — and it is named here rather than silently skipped
      for (const link of symlinkedChildRoots(under, parentDir)) {
        violations.push({
          file: rel(link),
          msg: `is a symlink — ${name} records are read only from real folders inside ${under.collection} records; whatever this points at is not indexed. Replace it with a real folder.`,
        })
      }
      const onLink = (p: string): void => {
        violations.push({
          file: rel(p),
          msg: `is a symlink inside a ${under.collection} record's folder — nothing behind it is read as a ${name} record, and nothing is written through it. Replace it with a real folder or file.`,
        })
      }
      for (const r of placedRecords(d, dir, parentDir, onLink)) {
        if (claim(r.id, r.file, storageOf(d).repo)) seen.set(r.id, r.parentId)
      }
      continue
    }
    // Claimants are GATHERED first: the first answers, exactly as the store indexes, and every other is
    // the duplicate reported above.
    const offers = new Map<string, string[]>() // id -> files, walk order
    const offer = (id: string, f: string): void => {
      const o = offers.get(id)
      if (o) o.push(f)
      else offers.set(id, [f])
    }
    const shape = storageOf(d).shape ?? "file"
    if (fs.existsSync(dir) && shape === "folder") {
      // a FILE record at the root of a folder-shape collection is the state a collection is in
      // right after its shape changed — named as such, with the verb that finishes the change
      const asFile = { ...d, storage: { ...d.storage, shape: "file" as const } }
      for (const entry of fs.readdirSync(dir).sort()) {
        if (entry.startsWith(".")) continue
        const p = path.join(dir, entry)
        if (!fs.statSync(p).isDirectory()) {
          const legacy = idFromRecordPath(asFile, entry) !== null
          strays.push({
            collection: name,
            file: rel(p),
            note: legacy
              ? `a file-shape record in a folder-shape collection — dreamteamer relocate ${name} moves it to ${entry.split(".")[0]}/${storageOf(d).entry}`
              : undefined,
          })
          continue
        }
        const main = path.join(p, storageOf(d).entry ?? "SKILL.md")
        if (fs.existsSync(main)) offer(entry, main)
        else strays.push({ collection: name, file: rel(p), note: `missing entry file ${storageOf(d).entry}` })
      }
    } else if (fs.existsSync(dir)) {
      for (const f of walk(dir)) {
        const id = idFromRecordPath(d, path.relative(dir, f))
        if (id === null) {
          strays.push({ collection: name, file: rel(f) })
          continue
        }
        // One id is one file. Under a fixed-extension format this cannot happen; under `binary` it can.
        offer(id, f)
      }
    }
    const opaque = storageOf(d).format === "binary"
    const allowed = storageOf(d).accept // undefined = any
    const max = storageOf(d).max_bytes ?? MAX_RECORD_BYTES
    for (const [id, list] of offers) {
      const [f] = list
      for (const c of list) claim(id, c, storageOf(d).repo) // the second and later are reported as duplicates
      if (!opaque) continue
      const ext = path.extname(f).slice(1).toLowerCase()
      if (allowed && !allowed.includes(ext)) {
        violations.push({
          file: rel(f),
          msg: `collection "${name}" does not accept .${ext} — its declared extensions are ${allowed.join(", ")}`,
        })
      }
      const size = fs.statSync(f).size
      if (size > max) {
        violations.push({
          file: rel(f),
          msg: `is ${size} bytes, over collection "${name}"'s max_bytes of ${max} — a record is a small file; a big one belongs outside the vault`,
        })
      }
    }
  }

  const flag = (file: string, msg: string): void => {
    violations.push({ file: rel(file), msg })
  }

  // parsed fields, kept for the relations pass below (parse each record exactly once)
  const parsed = new Map()
  const softRefs = new Map() // absent-but-declared peer collection -> how many refs point at it
  // cr-dt-004: this workspace's exports manifest, and the references it vouches for
  const facts = exportsFacts(root)
  const ctx = exportsContext({ root, descriptors, own: facts.own, dataPath: facts.data })
  let manifest: ExportRefs | null = null
  try {
    manifest = readExports(root)
  } catch (e) {
    violations.push({ file: rel(path.join(root, EXPORTS_FILE)), msg: e.message })
  }
  const external = { refs: 0, targets: new Set<string>() }

  for (const [name, d] of descriptors) {
    const validate = ajv.compile(jsonSchemaOf(d))
    const refFields = collectRefFields(fieldsOf(d))
    const softTargets = unresolvedPeersOf(d).length ? new Set(unresolvedPeersOf(d)) : null
    const bodyField = bodyFieldOf(d)
    parsed.set(name, new Map())

    for (const [id, file] of index.get(name)) {
      if (idsOf(d).pattern && !patternRe(idsOf(d).pattern).test(id)) {
        flag(file, `id "${id}" does not match pattern ${idsOf(d).pattern}`)
      }
      let fields
      try {
        fields = parseRecord(file, d, bodyField)
      } catch (e) {
        flag(file, `parse error: ${e.message}`)
        continue
      }
      if (!validate(fields)) {
        for (const err of validate.errors) flag(file, fmtAjvError(err, fields))
      }
      for (const k of unknownFields(d, fields)) {
        flag(file, `unknown field "${k}" (not in the ${name} schema)`)
      }
      for (const [fieldPath, target, soft] of refFields) {
        for (const value of valuesAt(fields, fieldPath)) {
          checkRef(file, fieldPath, value, target, softTargets, soft)
        }
      }
      // placement: the FIELD is the intended owner, the FOLDER is observed placement
      // Reported, never repaired: a record found under the wrong company is either a hand move
      // (the field is right, run relocate) or a hand edit of the field (the folder is right, set
      // it back) and only a person knows which. A malformed owner value is skipped here — the
      // reference check above has already named it, and "placed under X but owner is empty"
      // on top of that would be a second report of one typo.
      const under = placementOf(d)
      if (under) {
        const raw = fields[under.parent]
        const wellFormed = raw == null || raw === "" || (typeof raw === "string" && parseRef(raw, namespaces))
        const want = ownerIdOf(fields, under, v => parseRef(v, namespaces))
        const got = observed.get(name).get(id)
        if (under.id === "nested" && want && id.split("/")[0] !== want) {
          flag(
            file,
            `id "${id}" begins with "${id.split("/")[0]}" but ${under.parent} is ${under.collection}/${want} — a nested id begins with its parent's. Rename it: dreamteamer rename ${name}/${id} ${want}/${id.slice(id.indexOf("/") + 1)}`
          )
        }
        if (wellFormed && want !== got) {
          const where = got ? `under ${under.collection}/${got}` : `in its own root (${storageOf(d).path})`
          const should = want ? `${under.parent} is ${under.collection}/${want}` : `${under.parent} is empty`
          flag(
            file,
            `placed ${where} but ${should} — the file is not where its owner puts it. Run: dreamteamer relocate ${name}/${id}`
          )
        }
      }
      parsed.get(name).set(id, fields)
    }
    // descriptor v2: `unique: true` on a scalar field — the second record holding a value is the
    // one reported, naming the first. Null and absent never claim.
    for (const [field, f] of Object.entries(d.compiled?.fields ?? {})) {
      if (!f.unique || f.many) continue
      const seen = new Map()
      for (const [id, fields] of parsed.get(name)) {
        const v = fields[field]
        if (v === undefined || v === null || v === "") continue
        if (seen.has(v))
          flag(index.get(name).get(id), `${field}: "${v}" is already taken by ${name}/${seen.get(v)} (unique)`)
        else seen.set(v, id)
      }
    }
  }

  // relations: mirrors are DERIVED state
  // The owning side's foreign key is the truth; the mirror on the target is a cache of it, kept by
  // the store. So this is not a "do both sides agree" test between two equal authorities — check
  // recomputes what the owners imply and reports any mirror that has fallen behind. The fix is
  // therefore mechanical (`relations rebuild`), which is what the message says, rather than a
  // judgement call about which side is right.
  for (const relation of relationsOf(descriptors)) {
    const owners = [...(parsed.get(relation.owner) ?? [])].map(([id, fields]) => ({
      id,
      fields,
      repo: fileRepo.get(index.get(relation.owner).get(id)),
    }))
    // PER REPO: a mirror is kept only between records of one repo (store.js applyMirrorEdits), so
    // the expectation on a target is computed from the owners in ITS repo.
    const byRepo = new Map()
    for (const o of owners) {
      if (!byRepo.has(o.repo)) byRepo.set(o.repo, [])
      byRepo.get(o.repo).push(o)
    }
    const expByRepo = new Map([...byRepo].map(([r, os]) => [r, expectedMirrors(relation, os)]))

    // a unique owner reference is one-to-one, so two owners naming one target is a conflict the mirror
    // physically cannot represent (it is a scalar) — reported on the SECOND claimant, where the
    // edit that has to change is.
    if (relation.unique) {
      const seen = new Map()
      for (const { id, fields } of owners) {
        const v = fields?.[relation.field]
        // a union FK yields one relation row per target collection; without this filter each
        // row would re-flag the same duplicate once per member.
        if (typeof v !== "string" || !v.startsWith(`${relation.target}/`)) continue
        if (seen.has(v))
          flag(
            index.get(relation.owner).get(id),
            `${relation.field}: "${v}" is already taken by ${relation.owner}/${seen.get(v)} (unique)`
          )
        else seen.set(v, id)
      }
    }

    for (const [id, fields] of parsed.get(relation.target) ?? []) {
      const expected = expByRepo.get(fileRepo.get(index.get(relation.target).get(id)))?.get(id)
      if (!sameMirror(relation, fields?.[relation.mirror], expected))
        flag(
          index.get(relation.target).get(id),
          `${relation.mirror}: stale — run: dreamteamer relations rebuild ${relation.target}`
        )
    }
  }

  function checkRef(
    file: string,
    fieldPath: string[],
    value: unknown,
    targets: "*" | string[],
    softTargets: Set<string> | null,
    soft = false
  ): void {
    if (typeof value !== "string") return
    if (value.startsWith("@")) return // runtime tokens (@me, @initiator) are legal
    // The SAME parser the store writes through (src/namespace.ts) — `check` disagreeing with the
    // write path about where a namespace ends would flag valid records and pass invalid ones.
    const ref = parseRef(value, namespaces)
    if (!ref) return flag(file, `${fieldPath.join(".")}: reference "${value}" is not <collection>/<id>`)
    const { collection: coll, id } = ref
    if (targets !== "*" && !targets.includes(coll)) {
      const want = targets.length === 1 ? `collection "${targets[0]}"` : `one of: ${targets.join(", ")}`
      return flag(file, `${fieldPath.join(".")}: reference "${value}" should target ${want}`)
    }
    if (!descriptors.has(coll)) {
      // A collection the owning module DECLARED as a peer and nothing installed provides is the
      // normal state of a module opened on its own — the reference is unresolvable, not wrong.
      // `unresolved_peers` is stamped by compile so this layer never has to know what a module
      // is (see the record/workspace split in CLAUDE.md).
      if (softTargets?.has(coll)) {
        softRefs.set(coll, (softRefs.get(coll) ?? 0) + 1)
        return
      }
      // A SOFT reference (`soft: true`) names its target collection, and a missing record is tolerated.
      if (soft) return
      return flag(file, `${fieldPath.join(".")}: reference "${value}" targets unknown collection "${coll}"`)
    }
    if (!index.get(coll).has(id)) {
      if (soft) return // resolve if present, ignore if absent
      if (storageOf(descriptors.get(coll)).unavailable) return // the collection is unread here, not empty
      // listed by this workspace's exports manifest, its holder not read here: external (cr-dt-004)
      const e = manifest?.[coll]?.[id]
      if (e && !sees(e, coll, ctx)) {
        external.refs++
        external.targets.add(`${coll}/${id}`)
        return
      }
      return flag(
        file,
        `${fieldPath.join(".")}: dangling reference "${value}" — no such record${e ? ` (its holder ${e.from} is read here and does not have it)` : ""}`
      )
    }
  }

  // an extension's warning is printed and never counted: a disagreement worth seeing that must not turn
  // the workspace red (src/api.ts contributedViolations carries the mark)
  violations.push(...extra.filter(v => !v.warning))
  for (const s of strays) {
    console.log(`⚠ ${s.file} — unrecognized file in ${s.collection} folder${s.note ? ` (${s.note})` : ""}`)
  }
  for (const note of notes.values()) console.log(note)
  const upTo3 = (xs: string[]): string =>
    (xs.length > 3 ? [...xs.slice(0, 3), `+${xs.length - 3} more`] : xs).join(", ")
  if (external.refs)
    console.log(
      `ℹ ${external.refs} reference${external.refs === 1 ? "" : "s"} to ${external.targets.size} record${external.targets.size === 1 ? "" : "s"} outside this workspace, vouched for by its exports manifest (${upTo3([...external.targets].sort())})`
    )
  // a manifest is stale exactly when `dt exports` here would change or drop one of its entries
  if (manifest) {
    const held = (c: string, id: string): boolean => !!index.get(c)?.has(id)
    const records = [...parsed].flatMap(([c, m]) =>
      [...m].map(([id, fields]) => ({ collection: c, id, fields, descriptor: descriptors.get(c) }))
    )
    const outside = outsideRefs({ records, held, resolve: () => null, namespaces })
    const { changes } = regenerate({ current: manifest, outside, ctx, held })
    if (isStale(changes)) {
      const stale = changes.filter(x => x.kind !== "add")
      const msg = `stale — ${upTo3(stale.map(x => `${x.ref} (${x.kind}: ${x.why})`))}. dt exports`
      if (strictExport) violations.push({ file: rel(path.join(root, EXPORTS_FILE)), msg })
      else console.log(`⚠ ${rel(path.join(root, EXPORTS_FILE))} is ${msg}`)
    }
  }
  // Warned, never silent: the references are real and currently resolve to nothing. This is the
  // expected reading when a module is opened without the workspace that provides the concept.
  for (const [coll, n] of [...softRefs].sort()) {
    console.log(
      `⚠ peer collection "${coll}" is declared but not installed — ${n} reference${n === 1 ? "" : "s"} unresolvable`
    )
  }
  for (const w of extra.filter(v => v.warning)) console.log(`⚠ ${w.file} — ${w.msg}`)
  // the nav document: a name that resolves to nothing or is listed twice is worth seeing, never a
  // violation — the drawing skips the one and draws the other at its first place (design §3 rule 5)
  try {
    const nav = readNavDoc(root)
    if (nav)
      for (const { warning } of validateNavDoc(nav, { collections: new Set(descriptors.keys()), namespaces }))
        console.log(`⚠ nav.yaml — ${warning}`)
  } catch (e) {
    if (!(e instanceof NavDocError)) throw e
    console.log(`⚠ nav.yaml — ${e.message}`)
  }
  if (violations.length === 0) {
    console.log(
      `✔ 0 violations (${[...index.values()].reduce((n, m) => n + m.size, 0)} records across ${descriptors.size} collections)`
    )
    return 0
  }
  let last = null
  for (const v of violations) {
    if (v.file !== last) console.log(`✖ ${v.file}`)
    console.log(`    ${v.msg}`)
    last = v.file
  }
  console.log(`${violations.length} violation${violations.length === 1 ? "" : "s"}. files were NOT modified.`)
  return 1
}

/**
 * a unique relation mirrors to a scalar, everything else to a sorted array — compare in the shape the
 * mirror is actually written in (absent and empty are the same reading)
 */
function sameMirror(relation: Relation, actual: unknown, expected: unknown): boolean {
  return relation.unique
    ? (actual ?? null) === (expected ?? null)
    : JSON.stringify([...((actual as string[] | null | undefined) ?? [])].sort()) === JSON.stringify(expected ?? [])
}
