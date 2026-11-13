// Shared by scripts/layers.mjs and the public-API closure test: is a matched import edge erased at run
// time? `import type` / `export type` / `typeof import('./x.ts')` are, by construction under
// verbatimModuleSyntax — so they load nothing, and are no edge of the runtime graph either one draws.
export const typeOnly = (body, m) => /^\s*(?:import|export)\s+type\b/.test(m[0]) || /\btypeof\s*$/.test(body.slice(Math.max(0, m.index - 12), m.index));
