/** Operators whose operand matches PART of a value: a rename can change what they select, and no
 *  mechanical rewrite says how — so one that selects the old value is refused by name. */
export const PARTIAL_OPS: Record<string, (v: string, o: string) => boolean> = {
  _contains: (v, o) => v.includes(o),
  _ncontains: (v, o) => v.includes(o),
  _icontains: (v, o) => v.toLowerCase().includes(o.toLowerCase()),
  _starts_with: (v, o) => v.startsWith(o),
  _istarts_with: (v, o) => v.toLowerCase().startsWith(o.toLowerCase()),
  _ends_with: (v, o) => v.endsWith(o),
  _iends_with: (v, o) => v.toLowerCase().endsWith(o.toLowerCase()),
  _regex: (v, o) => {
    try {
      return new RegExp(o).test(v)
    } catch {
      return false
    }
  },
}
