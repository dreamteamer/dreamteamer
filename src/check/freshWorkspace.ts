import fs from "node:fs"
import path from "node:path"
import { ENGINE } from "./consts.ts"
import { engineRun } from "./engineRun.ts"

/** A fresh workspace in `root` on `engine`: the engine declared as a `file:` dependency and linked
 *  before `init`, so init finds it present and asks no registry. Throws with init's words on failure. */
export function freshWorkspace(root: string, engine: string = ENGINE): string {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: path
          .basename(root)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-"),
        private: true,
        dependencies: { dreamteamer: `file:${engine}` },
      },
      null,
      "\t"
    ) + "\n"
  )
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true })
  fs.symlinkSync(engine, path.join(root, "node_modules", "dreamteamer"), "dir")
  const r = engineRun(engine, root, ["init", "--no-input"], { timeoutMs: 180_000 })
  if (r.status !== 0)
    throw new Error(`dt init failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split("\n")[0]}`)
  return root
}
