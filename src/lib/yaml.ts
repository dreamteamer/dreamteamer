import yaml from "js-yaml"
import type { Pair, Node } from "yaml"
import { endOf } from "./endOf.ts"

/**
 * Parse YAML. `T` is the shape the CALLER expects — YAML is untrusted input, so it is asserted here and
 * validated where it is used (compile, check), never assumed checked by this call.
 */
export const load = <T = unknown>(text: string): T => yaml.load(text, { schema: yaml.CORE_SCHEMA }) as T

export const dump = (obj: unknown, opts: Record<string, unknown> = {}): string =>
  yaml.dump(obj, { lineWidth: 120, ...opts })

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
