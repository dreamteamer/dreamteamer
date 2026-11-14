/** A view's display: the collection's four sub-blocks, with `nav.title` because a view has no
 *  descriptor title of its own, and `options` on the record page as well as the list. */
export const VIEW_DISPLAY: Record<string, string[]> = {
  nav: ["title", "icon", "order"],
  list: ["layout", "columns", "sort", "options"],
  record: ["layout", "subtitle", "badge", "color_by", "options"],
  form: ["sections"],
}

/** Layout options that take a FIELD, named for the role it plays; and the ones that take a template. */
export const FIELD_OPTIONS = ["color_by", "group_by", "lanes_by", "start", "end", "lat", "lng"]

export const TEMPLATE_OPTIONS = ["card_title", "bar_title", "group_title", "group_summary"]

export const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

export const BUILTIN_FIELDS = ["id", "created", "last_modified"]

export const has = (fields: Record<string, unknown>, f: string): boolean => BUILTIN_FIELDS.includes(f) || f in fields
