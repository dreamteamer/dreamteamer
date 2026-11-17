import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { Module } from "../types/Module.ts"

/**
 * The engine's own system module, `dreamteamer`: the collections every workspace has (`repos`, `agents`, `collections`
 * …), the `entity` and `docs` mixins, the `using-dreamteamer` skill and the `dreamteamer` agent. They are the released
 * engine's files at the version below, copied byte for byte into this repository's top-level folders.
 */
export function systemModule(): Module {
  const m: Module = {
    name: "dreamteamer",
    version: "0.49.1",
    dir: dirname(fileURLToPath(new URL("../../package.json", import.meta.url))),
    origin: "engine",
    title: "System",
    namespaces: [],
    dependencies: [],
    peers: [],
    unsupported: [],
  }
  return m
}
