import path from "node:path"
import fs from "node:fs"
import { Store } from "./store/Store.ts"
import { commitPending } from "./changes/commitPending.ts"
import { emit } from "./lib/emit.ts"
import { storageOf } from "./record/storageOf.ts"
import { renderStatusLines } from "./setup/renderStatusLines.ts"
import { statusLines } from "./setup/statusLines.ts"
import type { Workspace } from "./types.ts"
import { locationOf } from "./compile/compile.ts"
import { CHANNEL_LABEL } from "./compile/consts.ts"
import { describeCheckout } from "./lib/git/describeCheckout.ts"
import { discoverModules } from "./workspace/discoverModules.ts"
import { listRepos } from "./repos/listRepos.ts"
import { staleness } from "./compile/staleness.ts"
import { presetMembers } from "./install/presetMembers.ts"

export function statusCommand(ws: Workspace, rest: string[]): number {
  const s = staleness(ws.root)
  if (!s.compiled) {
    console.log(`✖ ${s.message}`)
    return 1
  }
  if (rest.includes("--json")) {
    const { modules: mods } = discoverModules(ws.root, ws.pkg)
    const presets = presetMembers(ws)
    const modEntry = (m: (typeof mods)[number]) => ({
      name: m.name,
      location: locationOf(m, ws.root),
      ...(presets.has(m.name) ? { preset: true, members: presets.get(m.name)!.members } : {}),
    })
    emit(
      JSON.stringify(
        {
          workspace: { root: ws.root, name: ws.pkg?.name ?? null },
          compiled: s.manifest.compiled,
          stale: s.stale,
          modules: mods.map(modEntry),
          setup: statusLines(ws),
        },
        null,
        2
      )
    )
    return 0
  }
  console.log(`compiled: ${s.manifest.compiled}`)
  // THE EDITOR, from the marker the extension writes on activation (`.dreamteamer/editor.json`).
  // Without it an agent working inside the editor could not tell whether the extension was
  // installed, active, or refusing the engine — the operator had to report "no icon".
  try {
    const marker = path.join(ws.root, ".dreamteamer", "editor.json")
    if (fs.existsSync(marker)) {
      const e = JSON.parse(fs.readFileSync(marker, "utf8"))
      console.log(
        `editor: ${e.extension ?? "dreamteamer-vscode"} ${e.version ?? "?"} · ${e.state ?? "active"} ${e.activated ?? ""} · engine ${e.engine ?? "?"}${e.host ? ` · ${e.host}` : ""}`
      )
    } else
      console.log(
        "editor: not detected — the extension dreamteamer.dreamteamer-vscode writes .dreamteamer/editor.json when it activates on this workspace"
      )
  } catch {
    console.log("editor: marker unreadable — .dreamteamer/editor.json is not JSON")
  }
  // provenance is LIVE discovery (not the manifest) — shows what the next compile would use
  const { modules, shadows } = discoverModules(ws.root, ws.pkg)
  const shadowed = new Map(shadows.map(sh => [sh.name, sh]))
  const presets = presetMembers(ws)
  console.log("modules:")
  for (const m of modules) {
    // §10: the folder name IS the label — `[inline]` needed a legend every single time.
    let line = `  ${m.name.padEnd(20)} ${locationOf(m, ws.root)}`
    // a development link (a folder spec): never pinned, skipped by update
    try {
      if (
        m.channel === "npm" &&
        fs.lstatSync(path.join(ws.root, "node_modules", m.name)).isSymbolicLink() &&
        m.name !== "dreamteamer"
      )
        line += " (linked)"
    } catch {
      /* not under node_modules */
    }
    const sh = shadowed.get(m.name)
    if (sh) line += ` — shadows ${CHANNEL_LABEL[sh.loser]} copy`
    // a MODULE PRESET (CR-dt-008): how many members are here, then each absent and each drifted one
    const p = presets.get(m.name)
    if (p) line += ` · preset · ${p.members.length} members · ${p.members.filter(x => x.installed).length} installed`
    console.log(line)
    if (p) {
      for (const x of p.members) if (!x.installed) console.log(`    ${x.name}  not installed — dt install ${x.name}`)
      for (const x of p.members)
        if (x.installed && x.installed !== x.pinned)
          console.log(`    ${x.name} ${x.installed} (preset ${p.id} names ${x.pinned})`)
    }
  }
  // env-pointed roots (`storage.path: ${env:NAME}/…`), rendered per machine by compile: the
  // folder a record of each lands in on THIS machine, or why it cannot. Wrapped like the
  // blocks below — status is the command run when things are already wrong.
  try {
    const pointed = [...new Store(ws).descriptors.values()].filter(
      d => typeof d.storage?.path === "string" && d.storage.path.includes("${")
    )
    if (pointed.length) {
      console.log("storage:")
      for (const d of pointed) {
        const st = storageOf(d)
        console.log(
          `  ${d.name.padEnd(20)} ${st.unavailable ? `✖ ${d.storage.path} — ${st.unavailable}` : `${st.path} (${d.storage.path})${st.external ? " — outside every repo here, never committed" : ""}`}`
        )
      }
    }
  } catch {
    /* no runtime yet — status must still print */
  }
  // ⚠ WHICH CHECKOUT AM I. Everything `install` decides turns on this, and a linked
  // worktree is indistinguishable from the primary by eye — so it is stated. Wrapped like
  // every other block below: `status` is the command run when things are already wrong.
  try {
    const co = describeCheckout(ws.root)
    console.log(`checkout: ${co.kind === "primary" ? "primary" : `linked worktree of ${co.primary}`}`)
  } catch {
    /* not a git checkout */
  }
  if (ws.extensions.length) console.log(`extensions: ${ws.extensions.map(e => `${e.name}@${e.version}`).join(" · ")}`)
  console.log(`entries:  ${Object.keys(s.manifest.entries).length}`)
  // repos materialize LAZILY, so presence is REPORTED here rather than stored on the
  // record. Wrapped: an older workspace may predate the repos descriptor, and status
  // must never crash — it is the command you run when things are already wrong.
  try {
    const repos = listRepos(ws)
    if (repos.length) {
      const here = repos.filter(r => r.present).length
      console.log(`repos:    ${here}/${repos.length} materialized`)
      // an UNRESOLVED path is not the same absence as a repo simply not cloned yet, and
      // `dreamteamer install repos/<id>` is not the fix for it — say which one this is.
      for (const r of repos)
        if (!r.present)
          console.log(
            `  absent: ${r.id} → ${r.path}${r.unresolved ? ` — ${r.unresolved}` : ` (dreamteamer install repos/${r.id})`}`
          )
    }
  } catch {
    /* no repos descriptor compiled — nothing to report */
  }
  // `dt changes` lists the uncommitted records one by one (0.42.0); status keeps the
  // COUNT per repo, so deferred work is visible at a glance here too.
  try {
    const pending = commitPending(new Store(ws), { dryRun: true })
    const total = pending.reduce((n, r) => n + r.rows.length, 0)
    if (total) {
      console.log(`\npending: ${total} record(s) written but not committed — run \`dreamteamer commit\``)
      for (const r of pending) console.log(`  ${r.repo === "." ? "workspace" : r.repo}: ${r.rows.length}`)
    }
  } catch {
    /* no runtime yet, or not a git repo — status must still print */
  }
  // the SETUP section (src/setup.js): one line per unit the installed modules declare, folded
  // from each unit's own inspect — read-only, and never from a stored success flag
  try {
    for (const line of renderStatusLines(statusLines(ws))) console.log(line)
  } catch (e) {
    console.log(`setup: could not be read — ${e.message.split("\n")[0]}`)
  }
  if (s.stale.length) {
    for (const line of s.stale) console.log(`  stale: ${line}`)
    console.log(`✖ .dreamteamer is stale (${s.stale.length}) — run \`dreamteamer compile\``)
    return 1
  }
  console.log("✔ .dreamteamer is fresh")
  return 0
}
