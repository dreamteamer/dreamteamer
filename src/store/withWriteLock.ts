import fs from "node:fs"
import path from "node:path"
import type { Store } from "./Store.ts"

export function withWriteLock<T>(store: Store, fn: () => T): T {
  const lock = store.writeLockPath()
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
          fs.rmdirSync(lock)
          continue
        }
      } catch {
        /* raced the holder */
      }
      if (Date.now() > deadline)
        throw new Error(
          "another dreamteamer process holds the write lock (.dreamteamer/.write-lock) — retry, or remove it if nothing is running.",
          { cause: e }
        )
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50) // sync sleep, no busy spin
    }
  }
  try {
    return fn()
  } finally {
    try {
      fs.rmdirSync(lock)
    } catch {
      /* already gone */
    }
  }
}
