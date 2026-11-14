import yaml from "js-yaml"
import type { Pair, Node } from "yaml"
import { endOf } from "./endOf.ts"

/** Parse YAML. `T` is the shape the CALLER expects — YAML is untrusted input, so it is asserted here and
 *  validated where it is used (compile, check), never assumed checked by this call. */
export const load = <T = unknown>(text: string): T => yaml.load(text, { schema: yaml.CORE_SCHEMA }) as T

export const dump = (obj: unknown, opts: Record<string, unknown> = {}): string =>
  yaml.dump(obj, { lineWidth: 120, ...opts })

// ---- writing a source a HUMAN wrote ---------------------------------------------
//
// `dump` is for GENERATED output — the compiled runtime, a record's front matter, a harness file —
// where nothing was hand-formatted and byte-stability is the only thing that matters. A module
// SOURCE is the opposite case: it is hand-written, and it is where a module records WHY a collection
// exists. `load` → mutate → `dump` destroys all of that, because a dump re-derives the whole file
// from the parsed value: every comment gone, every flow form (`templates: [a]`, `storage: { … }`)
// expanded to block, every hand-folded scalar re-wrapped at the writer's own width. One `add-field`
// on a commented descriptor took it to zero comments, and one namespacing migration lost 194 comment
// lines across 24 descriptors — headers stating what belongs in a collection and which failure mode
// it guards against. Nothing warned; the schema was unchanged, so every gate stayed green.
//
// Three hand-rolled textual workarounds were written against this before it was fixed properly (a
// `setScalar` regex, an `x-reference` line editor, and a `reattachComments` pass that could only
// carry TOP-LEVEL blocks). All three are retired by `writeSource`.
//
// ⚠ THE DOCUMENT API ALONE IS NOT ENOUGH, and that was measured rather than assumed. `yaml` keeps
// comments and key order across parse → mutate → stringify, but it re-derives STYLE from its options
// rather than from the source, so a plain round-trip still reformats: `[a, b]` gains or loses its
// padding depending on one global flag the file's own author used both ways, and a block-folded
// scalar is re-folded at `lineWidth` — hand-wrapping the library cannot see and cannot reproduce.
// Straight through the Document API, 27 of 92 hand-written sources round-tripped byte-identically.
//
// So the stringify is followed by a pass that puts the ORIGINAL BYTES back wherever nothing changed:
// walk the old and new documents together, and for every node — or every key/value pair — whose
// value is deep-equal on both sides, replace the newly-emitted span with the source it was parsed
// from. Unchanged means byte-identical BY CONSTRUCTION, so the diff can only ever be the mutation.
// With the pass, 92 of 92. `test/unit/yaml-source.test.js` is the reproduction.

// `lineWidth: 0` never re-folds — an unchanged scalar is restored verbatim below, and a changed one
// must not drag its neighbours onto new lines.
//
// ⚠ `flowCollectionPadding` is ONE flag for two conventions that genuinely differ. Counted over a
// real workspace's 92 hand-written sources: flow SEQUENCES are unpadded 183 times out of 183
// (`list_fields: [name, status]`), flow MAPPINGS are padded 118 times out of 120
// (`storage: { path: x }`). Only a CHANGED collection is re-emitted at all — everything else is
// restored byte-for-byte — and what these ops change is the sequences: `list_fields`, `required`,
// `enum` and `templates`. So the sequence convention wins, and a flow mapping loses its padding only
// on the line an `x-reference` retarget was already rewriting.
export const SOURCE_OPTS = { lineWidth: 0, flowCollectionPadding: false }

export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export const keyOf = (pair: Pair<unknown, unknown>): string =>
  String((pair.key as { value?: unknown } | null)?.value ?? pair.key)

export const lineEnd = (text: string, from: number): number => {
  const nl = text.indexOf("\n", from)
  return nl === -1 ? text.length : nl
}

export const commentLines = (node: { comment?: string | null } | null | undefined): number =>
  node?.comment == null ? 0 : node.comment.split("\n").length

export const nodeSpan = (text: string, n: Node, lines: number): [number, number] => [
  n.range[0],
  endOf(text, n.range[1], lines),
]

/** A pair's whole source — the key, the value, and any comment sitting between or after them. */
export const pairSpan = (text: string, p: Pair<Node, Node>, lines: number): [number, number] => [
  p.key.range[0],
  endOf(text, (p.value?.range ? p.value : p.key).range[1], lines),
]

/** Lines that are nothing but a comment — the quantity `writeGated`'s invariant protects. */
export const commentCount = (text: string): number => text.split("\n").filter(l => l.trimStart().startsWith("#")).length
