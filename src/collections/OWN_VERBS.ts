/** An IDENTITY entity kind — a compiled source file per id (skills, agents, commands, bindings,
 *  mixins, and any kind an extension contributes). Derived from the runtime rather than
 *  listed, so a contributed kind gets `set · rm · rename` without core knowing its name; `collections`,
 *  `ui-views` and `modules` have verbs of their own. */
export const OWN_VERBS = new Set(["collections", "ui-views", "modules"])
