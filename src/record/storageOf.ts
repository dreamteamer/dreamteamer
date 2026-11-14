import { block, defaults } from "./descriptor.ts"
import type { Descriptor, Storage } from "../types.ts"

/** Storage, resolved: what the author wrote over what compile supplied, plus the facts compile decided. */
export function storageOf(d: Descriptor): Storage {
  const a: Descriptor["storage"] = d?.storage ?? {}
  const s = defaults(d).storage ?? {}
  const out: Storage = {
    path: s.path ?? a.path, // compile records the RESOLVED path when it differs (an owns-data module's prefix)
    format: a.format ?? s.format ?? "md",
    shape: a.shape ?? s.shape ?? "file",
    suffix: a.suffix ?? s.suffix,
    repo: block(d).repo ?? ".",
    runtime: block(d).runtime === true,
    // An env-pointed root (`storage.path: ${env:NAME}/…`), rendered by compile for THIS machine.
    // `external`: the rendered folder is outside the workspace, so no repo here publishes it.
    // `unavailable`: it could not render (the var is unset or empty) and this says why — `path` is
    // then still the template, and a reader refuses or skips rather than touching a literal folder.
    external: block(d).external === true,
    unavailable: block(d).unavailable ?? null,
  } as Storage // layers/roots are set just below
  // write root first, then each record layer (a clone whose listed collections are read here)
  out.layers = (block(d).layers ?? []).map(l => ({ name: l.name, path: l.path, repo: l.repo }))
  out.roots = [
    { path: out.path, repo: out.repo },
    ...out.layers.map(l => ({ path: l.path, repo: l.repo, layer: l.name })),
  ]
  if (a.entry !== undefined) out.entry = a.entry
  if (a.max_bytes !== undefined) out.max_bytes = a.max_bytes
  if (a.accept !== undefined) out.accept = a.accept
  if (a.under)
    out.under = {
      parent: a.under.parent,
      subfolder: a.under.subfolder,
      collection: block(d).under_collection,
      id: a.under.id ?? "independent",
    }
  return out
}
