import type { CheckoutState, InstallStep } from "./types.ts"

/** The install plan as DATA: every step names what it found and what it would do, so the same
 * decisions are testable without a disk and printable without being run. Task 3 observes the state
 * and executes the steps; nothing here touches fs or git. */
export function planInstall(state: CheckoutState, opts: { linkEnv?: boolean } = {}): InstallStep[] {
  const { checkout: c } = state
  const steps: InstallStep[] = []
  // ⚠ EVERY declared direct dependency, not just the engine. A worktree whose engine is a mirrored dev
  // LINK used to read as ready while an installed extension was missing — so
  // npm never ran, and compile then refused the extension's source folder as an unknown kind.
  const missing = state.missingDeps ?? []
  steps.push(
    missing.length
      ? {
          id: "dependencies",
          label: `dependencies: ${missing.join(", ")} missing — npm ci --prefer-offline (package-lock.json) or npm install; a linked one is kept`,
          state: "todo",
        }
      : { id: "dependencies", label: "dependencies: every declared package present", state: "already" }
  )
  if (c.kind === "primary") steps.push({ id: "env", label: ".env: primary checkout — nothing to link", state: "skip" })
  else if (state.hasEnv && !state.envIsLink)
    steps.push({ id: "env", label: ".env: this worktree carries its own .env — left alone", state: "already" })
  else if (state.hasEnv && state.envIsLink)
    steps.push({ id: "env", label: ".env: linked to the primary", state: "already" })
  else if (!state.primaryHasEnv)
    steps.push({ id: "env", label: ".env: the primary has none — nothing to link", state: "skip" })
  else if (!c.insideRoot && !opts.linkEnv)
    steps.push({
      id: "env",
      label: ".env: NOT linked",
      state: "skip",
      why: "this worktree lies outside the primary root — credentials are not linked there by default; pass --link-env to override for this run",
    })
  else steps.push({ id: "env", label: `.env: link → ${c.primary}/.env`, state: "todo" })
  for (const a of state.localAssets) {
    const id = `asset:${a.rel}`
    if (a.presentHere && !a.isLinkHere)
      steps.push({ id, label: `${a.rel}: a real directory is here — left alone`, state: "already" })
    else if (a.isLinkHere) steps.push({ id, label: `${a.rel}: linked`, state: "already" })
    else if (c.kind === "primary")
      steps.push({ id, label: `${a.rel}: primary checkout — nothing to link`, state: "skip" })
    else if (!a.presentInPrimary)
      steps.push({
        id,
        label: `${a.rel}: absent in the primary — skipped (the doctor reports the capability degraded)`,
        state: "skip",
      })
    else steps.push({ id, label: `${a.rel}: link → ${c.primary}/${a.rel}`, state: "todo" })
  }
  // gitModules carries the declared clones that are MISSING on this checkout or off their declared
  // ref, not every declared one — the observer narrows it, which is what makes an empty array mean "nothing to restore"
  // rather than "none declared", and what lets a settled checkout plan with nothing todo.
  steps.push({
    id: "git_modules",
    label: state.gitModules.length
      ? `git modules: restore or re-point ${state.gitModules.join(", ")}`
      : "git modules: nothing to restore",
    state: state.gitModules.length ? "todo" : "skip",
  })
  steps.push({
    id: "compile",
    label: state.stale ? "compile: runtime missing or stale" : "compile: fresh",
    state: state.stale ? "todo" : "already",
  })
  steps.push(
    state.postinstall
      ? { id: "postinstall", label: `postinstall: ${state.postinstall}`, state: "todo" }
      : { id: "postinstall", label: "postinstall: none declared", state: "skip" }
  )
  return steps
}
