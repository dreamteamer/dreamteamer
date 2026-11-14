import { installCheckout } from "./installCheckout.ts"
import { installClone } from "./installClone.ts"
import { installModules } from "./installModules.ts"
import type { Workspace } from "../types.ts"
import { warnIfStale } from "../workspace/compile.ts"
import { listRepos } from "../workspace/listRepos.ts"

// ONE verb makes a thing present and ready: this checkout, or an attached repo's
// working tree. `ensure` was the second spelling of the same idea and is retired in the
// `default` arm below — no alias, per the 0.12.0 policy.
//
// ⚠ THREE FORMS, ONE FLAG TABLE — so each form REFUSES the other's vocabulary itself.
// `WORKSPACE_FLAGS.install` can only say which flags the verb has; it cannot know that
// `--dry-run` is meaningless once a target is named. Forwarding just the flags a form
// understands DROPS the rest in silence, and that is not a cosmetic loss:
// `dt install repos/x --dry-run` materialized the repo for real, driven past a flag
// whose entire meaning is "do nothing". A bare positional had the same shape of bug —
// `dt install <repo-id>`, the muscle memory `dt ensure <id>` taught for nine releases,
// matched neither branch, so the target was ignored and a whole checkout install ran.
// Same policy as the retired verbs below: a stale invocation fails loudly.
/** What `dt install` needs from outside its own command, handed in by the CLI — the same opener and
 *  verifier `init` is given — so this folder imports no other command and no entry point. */
export type InstallDeps = {
  /** opens a workspace with its extensions activated */
  open: (at: string) => Promise<Workspace>
  /** `dt check` on the installed workspace, with the extensions' own violations */
  verify: (ws: Workspace) => number | Promise<number>
  /** `dt install repos[/<id>]` — the `repos ensure` collection verb */
  ensureRepos: (args: string[]) => number
}

export async function installCommand(
  ws: Workspace,
  rest: string[],
  { open, verify, ensureRepos }: InstallDeps
): Promise<number> {
  const given = rest.filter(a => a.startsWith("--"))
  const refuse = (form: string, allowed: string[]): void => {
    const stray = given.filter(f => !allowed.includes(f))
    if (!stray.length) return
    throw new Error(
      `${stray.join(" ")} ${stray.length > 1 ? "are not flags" : "is not a flag"} of \`${form}\` — that form takes ${allowed.join(" ")}`
    )
  }
  const ci = rest.indexOf("--clone")
  if (ci > -1) {
    refuse("dt install --clone <url> [name]", ["--clone"])
    return installClone(ws, rest[ci + 1], rest[ci + 2])
  }
  const target = rest.find(a => !a.startsWith("--"))
  if (target === "repos" || target?.startsWith("repos/")) {
    refuse(`dt install ${target}`, ["--all", "--json"])
    warnIfStale(ws.root)
    const args = target === "repos" ? given : [target.slice("repos/".length), ...given]
    return ensureRepos(args)
  }
  // THE SPEC FORM (src/install-modules.js): any positional that is not `repos…` is an npm spec —
  // a name, name@version, ./file.tgz, ./folder, a git URL — and `--from` resolves names from a
  // folder of tarballs. The flags are its own; the checkout form's are refused on it below.
  if (target || given.includes("--from")) {
    // the muscle memory `dt ensure <id>` taught: a bare repo id is named with its spelling, never sent to npm
    let repoIds: string[] = []
    try {
      repoIds = listRepos(ws).map(r => r.id)
    } catch {
      /* no repos descriptor */
    }
    if (target && repoIds.includes(target))
      throw new Error(
        `"${target}" is an attached repo, not an npm spec — \`dt install repos/${target}\` materializes it`
      )
    refuse("dt install <spec…>", ["--from", "--input", "--allow", "--no-input", "--no-commit", "--json"])
    return await installModules(ws, rest, {
      open,
      verify,
    })
  }
  // ⚠ TWO MORE FORMS, EACH ITS OWN VOCABULARY. `--hook` reads a JSON payload off stdin
  // and installs the checkout that payload names; `--print-adapters` installs nothing
  // at all. Folding either into `dt install`'s flag list would let `--hook --dry-run`
  // through as a plan of a checkout nobody named, and `--print-adapters --link-env`
  // as a symlink placed by a verb whose whole job is to print.
  if (given.includes("--hook")) {
    refuse("dt install --hook", ["--hook"])
    return await installCheckout(ws, rest, { open })
  }
  if (given.includes("--print-adapters")) {
    refuse("dt install --print-adapters", ["--print-adapters"])
    return await installCheckout(ws, rest, { open })
  }
  refuse("dt install", ["--dry-run", "--json", "--link-env"])
  return await installCheckout(ws, rest, { open })
}
