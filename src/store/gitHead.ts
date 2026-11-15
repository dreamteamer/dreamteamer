import { execFileSync } from "node:child_process"
import { QUIET } from "../lib/consts.ts"
import type { Store } from "./Store.ts"

export function gitHead(store: Store) {
  if (store._head === undefined) {
    try {
      store._head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: store.root, stdio: QUIET }).toString().trim()
    } catch {
      store._head = "no-git"
    }
  }
  return store._head
}
