import fs from "node:fs"
import { atomicWrite } from "../lib/atomicWrite.ts"
import type { Store } from "./Store.ts"
import type { RewriteResult, Undo } from "./types.ts"
import { escapeRe } from "../lib/escapeRe.ts"

export function rewriteRefsBatch(store: Store, pairs: [oldRef: string, newRef: string][]): RewriteResult {
  const plans = pairs.map(([oldRef, newRef]) => {
    const oldBase = oldRef.split("/").pop()
    const newBase = newRef.split("/").pop()
    const bareRe = oldBase === newBase ? null : new RegExp(`\\[\\[${escapeRe(oldBase)}${ANCHOR_AND_LABEL}\\]\\]`, "g")
    return {
      oldRef,
      newRef,
      newBase,
      base: oldBase,
      bareRe,
      refRe: store.refRegex(oldRef),
      // ⚠ `newRef` MAY END IN `oldRef` — `ledger/beta` → `finance/ledger/beta` is the ordinary
      // shape of `collections rename`. Every occurrence this pass has just rewritten then still
      // matches the old needle at a legal boundary, so the raw-prose counter reported bytes that
      // are already correct: a warning naming work nobody needs to do. The guard is the
      // `endsWith`, and the second scan only runs for the pairs that fail it.
      newRefRe: newRef !== oldRef && newRef.endsWith(`/${oldRef}`) ? store.refRegex(newRef) : null,
      wikiRe: new RegExp(`\\[\\[${escapeRe(oldRef)}${ANCHOR_AND_LABEL}\\]\\]`, "g"),
      // asked of the id index, not of a text scan — and only when a bare pass can happen at all
      claimants: bareRe ? store.basenameOwners(oldBase) : [],
    }
  })
  // a bare pass matches `[[base]]`, which does NOT contain the ref — so the basename is a needle too
  const probe = commonPrefix(plans.flatMap(p => (p.bareRe ? [p.oldRef, p.base] : [p.oldRef])))

  const touched: string[] = []
  const skipped: RewriteResult["skipped"] = []
  const ambiguous: RewriteResult["ambiguous"] = []
  const undos: Undo[] = []
  let rewrites = 0
  // a COPY before reversing, as applyMirrorEdits does: `restore` may be called twice
  const restore = () => {
    for (const u of [...undos].reverse()) u()
  }
  try {
    for (const f of store.recordFiles()) {
      const text = fs.readFileSync(f, "utf8")
      if (probe && !text.includes(probe)) continue
      // prose scoping applies to EVERY .md — a frontmatter-less file is all body
      // (docs-audit catch: it used to fall through to raw replacement)
      const prose = f.endsWith(".md")
      const fm = prose ? /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/.exec(text) : null
      let head = prose ? (fm ? fm[1] : "") : text
      let body = prose ? (fm ? fm[2] : text) : ""
      let count = 0
      for (const p of plans) {
        head = head.replace(p.refRe, () => (count++, p.newRef))
        if (!prose) continue
        // the qualified pass FIRST: it turns `[[people/ada]]` into `[[people/ada-l]]`, which the
        // bare pattern cannot match either before or after, so the two never see each other's work
        body = body.replace(p.wikiRe, (_, anchor, label) => (count++, `[[${p.newRef}${anchor ?? ""}${label ?? ""}]]`))
        if (p.bareRe && !p.claimants.length)
          body = body.replace(
            p.bareRe,
            (_, anchor, label) => (count++, `[[${p.newBase}${anchor ?? ""}${label ?? ""}]]`)
          )
        else if (p.bareRe) {
          const n = (body.match(p.bareRe) ?? []).length
          if (n)
            ambiguous.push({
              file: f,
              count: n,
              base: p.base,
              claimants: p.claimants,
              oldRef: p.oldRef,
              newRef: p.newRef,
            })
        }
        // counted on the body this pair leaves behind, so a later pair sees what an on-disk
        // pass would have seen — raw prose is reported, never rewritten (decision 7)
        const raw = countRawOccurrences(body, p)
        if (raw) skipped.push({ file: f, count: raw, oldRef: p.oldRef, newRef: p.newRef })
      }
      if (count === 0) continue
      rewrites += count
      undos.push(() => atomicWrite(f, text))
      atomicWrite(f, head + body)
      touched.push(f)
    }
  } catch (e) {
    restore() // "nothing was rewritten" stays true of a batch that died half way through it
    throw e
  }
  return { touched, rewrites, skipped, ambiguous, restore }
}

/** What may sit between a wikilink's TARGET and its closing `]]`: an optional `#anchor`, then an
 *  optional `|label`. Two capture groups, in that order, both handed back verbatim by the rewrite.
 *
 *  ⚠ THE ANCHOR IS PART OF THE LINK, NOT OF THE TARGET. Both passes used to stop at the `]]` or the
 *  `|`, so `[[id#heading]]` survived a rename of `id` untouched — the bare form silently, the
 *  qualified form counted only as raw prose. Only the record moved; the heading inside it did not,
 *  so the anchor rides through byte for byte, whatever is in it (a heading slug is not an id — it
 *  holds spaces, case and punctuation). `[^\]|]` on the anchor is what keeps the two groups from
 *  swallowing each other. */
const ANCHOR_AND_LABEL = "(#[^\\]|]*)?(\\|[^\\]]*)?"

/** Raw occurrences of a pair's OLD ref in a body — what `rewriteRefsBatch` reports as skipped prose.
 *  An occurrence lying INSIDE one of `newRef` is not prose that was skipped, it is the rewrite this
 *  pass just made: `finance/ledger/beta` ends in `ledger/beta` and the boundary allows it. Only the
 *  pairs whose new spelling ends in the old one (`p.newRefRe`) pay for the second scan. */
function countRawOccurrences(body: string, p: { refRe: RegExp; newRefRe: RegExp | null }): number {
  p.refRe.lastIndex = 0
  if (!p.newRefRe) return (body.match(p.refRe) ?? []).length
  const spans: [number, number][] = []
  p.newRefRe.lastIndex = 0
  for (let m; (m = p.newRefRe.exec(body)) !== null;) spans.push([m.index, m.index + m[0].length])
  let n = 0
  for (let m; (m = p.refRe.exec(body)) !== null;) {
    const [start, end] = [m.index, m.index + m[0].length]
    if (!spans.some(([s, e]) => start >= s && end <= e)) n++
  }
  return n
}

/** The longest prefix every needle shares, or '' if they share none. Used ONLY as a negative filter
 *  (see rewriteRefsBatch): anything containing a needle contains this, so anything without it
 *  contains no needle — and a hit means nothing at all. */
function commonPrefix(needles: string[]): string {
  let p = needles[0] ?? ""
  for (const n of needles) {
    let i = 0
    while (i < p.length && p[i] === n[i]) i++
    p = p.slice(0, i)
    if (!p) break
  }
  return p
}
