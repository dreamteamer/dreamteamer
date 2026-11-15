import type { Workspace } from "../types.ts"
import { moduleIdOf } from "../compile/compile.ts"
import { installedModules } from "./installedModules.ts"

/** One member of an installed module preset: its pin, and what is installed (null when absent). */
export interface PresetMember {
  name: string
  pinned: string
  installed: string | null
}

/**
 * Every installed MODULE PRESET (CR-dt-008) and its members as the preset pins them against what is
 * installed: `installed` is the member's installed version, or null when it is absent. `dt status`
 * reads it (text and --json).
 */
export function presetMembers(ws: Workspace): Map<string, { id: string; members: PresetMember[] }> {
  const mods = installedModules(ws)
  const out = new Map<string, { id: string; members: PresetMember[] }>()
  for (const [name, m] of mods) {
    const preset = m.manifest?.dreamteamer?.preset
    if (!preset || typeof preset !== "object") continue
    out.set(name, {
      id: moduleIdOf(name),
      members: Object.entries(preset).map(([member, pinned]) => ({
        name: member,
        pinned,
        installed: mods.get(member)?.version ?? null,
      })),
    })
  }
  return out
}
