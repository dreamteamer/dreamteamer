/**
 * A view's display: the collection's four sub-blocks, with `nav.title` because a view has no
 * descriptor title of its own, and `options` on the record page as well as the list.
 */
export const VIEW_DISPLAY: Record<string, string[]> = {
  nav: ["title", "icon", "order"],
  list: ["layout", "columns", "sort", "options"],
  record: ["layout", "subtitle", "badge", "color_by", "options"],
  form: ["sections"],
}
