import path from "node:path"

/** The environment a shelled-out step gets: this process's, plus the directory of the node that is
 *  running it, at the FRONT of PATH.
 *
 *  ⚠ MEASURED, and it is the other half of `resolveNpm`. Resolving npm absolutely is not enough:
 *  npm's own shebang is `#!/usr/bin/env node`, so under a hook's environment
 *  (`env -i PATH=/usr/bin:/bin`) the resolved npm was found, spawned, and died at exit 127 with
 *  `env: node: No such file or directory` — the interpreter lookup, one level below the one the
 *  shim fixes. A declared `postinstall` has exactly the same problem for exactly the same reason,
 *  so both steps are handed the same environment. */
export const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: [path.dirname(process.execPath), process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
})
