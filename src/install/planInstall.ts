import type { CheckoutState, InstallStep } from "./types.ts"

/**
 * The install plan as DATA: every step names what it found and what it would do, so the same
 * decisions are testable without a disk and printable without being run. Task 3 observes the state
 * and executes the steps; nothing here touches fs or git.
 */
export function planInstall(state: CheckoutState, opts: { linkEnv?: boolean } = {}): InstallStep[] {
  const { checkout: c } = state
  const steps: InstallStep[] = []
  // ⚠ EVERY declared direct dependency, not just the engine. A worktree whose engine is a mirrored dev
  // LINK used to read as ready while an installed extension was missing — so
  // npm never ran, and compile then refused the extension's source folder as an unknown kind.
  const missing = state.missingDeps ?? []
  // ⚠ AND every one installed at another version than the checkout pins. A teammate's pushed upgrade moves the pins
  // while node_modules stays behind; "present" alone read that checkout as ready, and it ran on the old packages.
  const drift = state.drift ?? []
  const why = [
    ...(missing.length ? [`${missing.join(", ")} missing`] : []),
    ...drift.map(d => `${d.name} ${d.installed} installed, ${d.pinned} pinned`),
  ]
  steps.push(
    why.length
      ? {
          id: "dependencies",
          label: `dependencies: ${why.join("; ")} — npm ci --prefer-offline (package-lock.json) or npm install; a linked one is kept`,
          state: "todo",
        }
      : {
          id: "dependencies",
          label: "dependencies: every declared package present, at its pinned version",
          state: "already",
        }
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
