import { openWorkspace } from "../openWorkspace.ts"
import { findWorkspace } from "../workspace/findWorkspace.ts"

export async function run(args: string[]): Promise<number> {
  // `dt check modules/<id> --alone` judges one inline module in a fresh workspace (src/check/checkAlone.ts) —
  // decided before the host is opened, because the module's own problem (a missing dependency, a
  // floor above this engine) would otherwise surface as the host's refusal instead of the gate's verdict
  const target = args.find(a => !a.startsWith("--"))
  if (args.includes("--alone")) {
    const { checkAlone } = await import("../check/checkAlone.ts")
    return checkAlone(findWorkspace(), { target, keep: args.includes("--keep") })
  }
  if (target) {
    console.error(
      `✖ check takes no target — did you mean --alone? (dt check ${target} --alone judges one inline module)`
    )
    return 2
  }
  const ws = await openWorkspace()
  const [{ check }, { warnIfStale }] = await Promise.all([
    import("../check/check.ts"),
    import("../compile/warnIfStale.ts"),
  ])
  const extra = warnIfStale(ws.root).compiled ? await (await import("../api.ts")).contributedViolations(ws) : []
  return check(ws, { extra, strictExport: args.includes("--strict-export") })
}
