#!/usr/bin/env node
// contract — type-check test/types/consumer.ts, under `strict`, against the declarations the build
// GENERATES, installed the way a consumer sees them (node_modules/dreamteamer, resolved through the
// package `exports`). Exit 0 when the published types keep every promise the consumer makes.
//
//   node scripts/contract.ts              emit the declarations from src/ into a temp dir, then check
//   node scripts/contract.ts <dir>        check an existing declarations dir (dist/, say)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc")
const run = (args: string[], cwd: string) =>
  spawnSync(tsc, args, { cwd, encoding: "utf8", shell: process.platform === "win32" })

export function checkContract(decls: string | null = null): { ok: boolean; output: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-contract-"))
  try {
    if (!decls) {
      decls = path.join(tmp, "decls")
      const r = run(["-p", "tsconfig.build.json", "--declaration", "--emitDeclarationOnly", "--outDir", decls], root)
      if (r.status !== 0) return { ok: false, output: `declaration emit failed:\n${r.stdout}${r.stderr}` }
    }
    const pkg = path.join(tmp, "consumer", "node_modules", "dreamteamer")
    fs.mkdirSync(pkg, { recursive: true })
    fs.cpSync(decls, path.join(pkg, "dist"), {
      recursive: true,
      filter: f => fs.statSync(f).isDirectory() || f.endsWith(".d.ts"),
    })
    const { exports, dependencies } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "dreamteamer", type: "module", exports, dependencies })
    )
    // the engine's own dependencies, as an install would place them beside it
    for (const dep of Object.keys(dependencies ?? {}))
      fs.symlinkSync(path.join(root, "node_modules", dep), path.join(tmp, "consumer", "node_modules", dep), "junction")
    const consumer = path.join(tmp, "consumer")
    fs.copyFileSync(path.join(root, "test", "types", "consumer.ts"), path.join(consumer, "consumer.ts"))
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ type: "module" }))
    fs.writeFileSync(
      path.join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2023",
          lib: ["es2023"],
          types: ["node"],
          typeRoots: [path.join(root, "node_modules", "@types")],
          skipLibCheck: false,
        },
        files: ["consumer.ts"],
      })
    )
    const r = run(["-p", "tsconfig.json"], consumer)
    return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.replaceAll(consumer + path.sep, "") }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { ok, output } = checkContract(process.argv[2] ? path.resolve(process.argv[2]) : null)
  if (output.trim()) console.log(output.trim())
  console.log(
    ok
      ? "✔ the generated declarations keep the consumer contract"
      : "✖ the generated declarations break the consumer contract (test/types/consumer.ts)"
  )
  process.exit(ok ? 0 : 1)
}
