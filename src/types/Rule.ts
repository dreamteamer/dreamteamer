/**
 * A collection's cross-field rule: the part of JSON Schema the published modules write in `constraints`, read by
 * keyword. A keyword outside it is an error in the model, never skipped.
 */
export interface Rule {
  if?: Rule
  then?: Rule
  else?: Rule
  not?: Rule
  allOf?: Rule[]
  anyOf?: Rule[]
  oneOf?: Rule[]
  properties?: Record<string, Rule>
  items?: Rule
  required?: string[]
  /** the constant, boxed so that a constant of null is told from none */
  const?: { value: unknown }
  enum?: unknown[]
  type?: string[]
  pattern?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
}
