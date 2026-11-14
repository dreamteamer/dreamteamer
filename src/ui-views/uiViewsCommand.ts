import type { Workspace, Flags } from "../types.ts"
import { Store } from "../store/Store.ts"
import { need } from "../lib/need.ts"
import { dryRunPlan } from "../lib/dryRunPlan.ts"
import { removeUiView } from "./removeUiView.ts"
import { emit } from "../lib/emit.ts"
import { reportCommits } from "../workspace/reportCommits.ts"
import { oneValue } from "../lib/oneValue.ts"
import { VIEW_META_FLAGS } from "./lib/consts.ts"
import type { Flat } from "../lib/types.ts"
import { moveUiView } from "./moveUiView.ts"
import { assignViewValue } from "./lib/assignViewValue.ts"
import { slug } from "../record/template.ts"
import { saveUiView } from "./saveUiView.ts"
import { alreadyThat } from "../lib/alreadyThat.ts"
import { rel } from "../lib/rel.ts"

function metaUiView(ws: Workspace, store: Store, verb: string, flags: Flags, pos: string[]) {
  if (verb === "rm") {
    const viewId = need(pos, 0, "ui-view id")
    if (flags["dry-run"])
      return dryRunPlan(`rm ui-views/${viewId}`, { descriptors: 1 }, [
        "the view source is removed; its route stops resolving",
      ])
    const out = removeUiView(ws, store, viewId)
    if (flags.json) emit(JSON.stringify(out))
    else console.log(`✔ removed ui-view ${out.removed}`)
    console.log("✔ compiled — the route is gone")
    reportCommits(out.commits)
    return 0
  }

  // `set` edits what the record already says; `add` starts from nothing. Reading through the
  // store means `set` works on a MODULE-shipped view too — the edit lands as a workspace source
  // that shadows it, which is the same thing saving one in the UI does.
  let view: Record<string, unknown> = {}
  let id = oneValue(flags, "id")
  // `module=` on a set is the MOVE, spelled as it is for a collection (`dt set collections/<c>
  // module=<m>`): a value being written, not the `--module` selector `add` takes.
  const moveArg = verb === "set" ? pos.slice(1).find(p => p.startsWith("module=")) : undefined
  if (moveArg) {
    const viewId = id ?? need(pos, 0, "ui-view id")
    const moveTo = moveArg.slice("module=".length)
    const others = [
      ...pos.slice(1).filter(p => p !== moveArg && p.includes("=")),
      ...Object.keys(flags).filter(k => !VIEW_META_FLAGS.has(k) && k !== "dry-run"),
    ]
    if (others.length)
      throw new Error(
        `module= moves the view to another module; the other keys rewrite it. Run them as two commands: dreamteamer set ui-views/${viewId} module=${moveTo}, then dreamteamer set ui-views/${viewId} ${others.join(" ")}`
      )
    const out: Flat<ReturnType<typeof moveUiView>> = moveUiView(ws, store, viewId, moveTo, {
      dryRun: !!flags["dry-run"],
    })
    if (flags.json) {
      emit(JSON.stringify(out))
      return 0
    }
    if (out.dryRun)
      return dryRunPlan(`set ui-views/${viewId} module=${moveTo}`, { descriptors: 1 }, [
        `view source  ${out.from} → ${out.to} (${out.file})`,
      ])
    if (!out.moved) {
      console.log(`✔ ui-views/${viewId} — already in ${out.to}, nothing to do`)
      return 0
    }
    console.log(`✔ ui-views/${viewId}: ${out.from} → ${out.to} (${out.file})`)
    console.log("✔ compiled — the move is live")
    reportCommits(out.commits)
    return 0
  }
  if (flags["dry-run"])
    throw new Error("--dry-run plans a move (module=<m>); a key write has no plan to show — run it without the flag")
  if (verb === "set") {
    id ??= need(pos, 0, "ui-view id")
    const { fields } = store.read("ui-views", id)
    view = JSON.parse(JSON.stringify(fields))
    delete view.id // the id is the filename, never a body key
    delete view.compiled // compile's, rewritten on every compile
  }

  for (const p of pos.slice(verb === "set" ? 1 : 0)) {
    if (!p.includes("=")) continue
    assignViewValue(view, p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1))
  }
  for (const [k, v] of Object.entries(flags)) {
    if (VIEW_META_FLAGS.has(k)) continue
    // A view key holds ONE value, and a list IS one value — so a repeated flag is a mistake with
    // two spellings to correct it, rather than an array nobody asked for.
    if (Array.isArray(v)) {
      throw new Error(
        `--${k} was given ${v.length} times — a view key takes one value, and a list is written as one: --${k} ${v.join(",")} (or the JSON form '${JSON.stringify(v)}')`
      )
    }
    assignViewValue(view, k, v)
  }

  if (!view.route) throw new Error("missing --route </route> — a view is addressed by its route")
  // same id rule the descriptor declares (`{{ route | slug }}`) and the UI derives, so a view
  // saved from the CLI and one saved from the panel land on the SAME record.
  id ??= slug(view.route as string) // `--route` is a value flag

  const out: Flat<ReturnType<typeof saveUiView>> = saveUiView(ws, store, {
    id,
    view,
    moduleId: oneValue(flags, "module"),
  })
  if (flags.json) {
    emit(JSON.stringify(out))
    return 0
  }
  if (out.unchanged) return alreadyThat(`ui-views/${id}`)
  console.log(`✔ ${rel(ws.root, out.file)}`)
  console.log(`✔ compiled — ${view.route} is live`)
  reportCommits(out.commits)
  return 0
}

/** `dt add|set|rm ui-views/<id>` — or null for any other verb. */
export function uiViewsCommand(
  ws: Workspace,
  store: Store,
  collection: string,
  verb: string,
  flags: Flags,
  pos: string[]
): number | null {
  if (collection === "ui-views" && ["add", "set", "rm"].includes(verb)) return metaUiView(ws, store, verb, flags, pos)
  return null
}
