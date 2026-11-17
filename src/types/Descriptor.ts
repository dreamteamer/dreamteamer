import type { Module } from "./Module.ts"

/** A collection or mixin descriptor as read from its YAML file, before mixins, overlays and types are resolved. */
export interface Descriptor {
  module: Module
  file: string
  /** every top-level key, known or not */
  keys: string[]
  name?: string
  overlay: boolean
  singular?: string
  description?: string
  use_when?: string
  title?: string
  record_title?: string
  internal?: boolean
  sensitive?: boolean
  display?: Record<string, unknown>
  constraints?: Record<string, unknown>[]
  mixins: string[]
  /** null when the key is present and empty: it still replaces a mixin's */
  storage?: Record<string, unknown> | null
  ids?: Record<string, unknown> | null
  /** each field as written; read by type once overlays are merged */
  fields: Record<string, unknown>
}
