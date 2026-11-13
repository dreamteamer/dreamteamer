// The typed contract of `import … from 'dreamteamer/testing'` (src/testing.js): a module's own test
// suite on the real engine. Synchronous throughout. Policy (D64): on 0.x a breaking change to this
// export lands in a minor, announced one release ahead in UPDATING.md.

/** One engine run: its exit status (null when it was ended on `timeoutMs`), stdout and stderr. */
export interface Result { status: number | null; stdout: string; stderr: string }
export interface RunOptions {
	/** Laid over the process environment (and the synthetic git identity) for this run. */
	env?: Record<string, string>;
	/** Ends the run by SIGKILL after this many milliseconds; `status` is then null. Default 60 000. */
	timeoutMs?: number;
	/** Text handed to the run's stdin (a hook payload, a prompt's answer). */
	input?: string;
}
/** A workspace `createWorkspace` made: its root, the engine it runs on, and `run` bound to it. */
export interface Workspace { root: string; engine: string; dt(args: string[], opts?: RunOptions): Result }

/** The package root of the engine running this file — never one found on PATH. */
export const ENGINE: string;
/** `dt init` in a fresh temp folder on `engine`, else `DT_ENGINE_DIR`, else `ENGINE`. Throws if init fails. */
export function createWorkspace(opts?: { engine?: string }): Workspace;
/** `npm pack` of a module folder; the tarball's path. */
export function pack(moduleDir: string): string;
/** `dt install` of a name, a tarball path or a module folder (packed first). Exit 3 is a result. */
export function install(ws: Workspace, spec: string, opts?: RunOptions): Result;
/** The CLI of the workspace's engine, run in the workspace. */
export function run(ws: Workspace, args: string[], opts?: RunOptions): Result;
/** Does the running engine (or `DT_ENGINE_DIR`'s) satisfy the semver range? */
export function engineMeets(range: string): boolean;
