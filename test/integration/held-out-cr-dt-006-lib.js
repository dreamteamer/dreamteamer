// Shared support for the cr-dt-006 held-out tests (rnd/tests/cr-dt-006-he1 … he9) — written by the test
// stage from the held-out records, never by the builder. Every workspace is a folder under os.tmpdir()
// whose engine is THIS checkout (declared and linked, so `dt init` runs no npm for it), npm's registry
// is fenced to a closed port, HOME is a temp dir, and git may not climb above the sandbox.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync, execFileSync } from "node:child_process"
import { ENGINE_ROOT, SPAWN_TIMEOUT_MS, treeHash } from "../helpers/ws.js"

export { ENGINE_ROOT, treeHash }
// The engine under test: this checkout, or — DT_HELDOUT_ENGINE=<extracted candidate package> — the packed
// candidate itself (its runtime dependencies installed beside it), so the held-out run judges the tarball the
// acceptance ran from rather than a working tree. Fixtures are always this checkout's.
export const ENGINE = process.env.DT_HELDOUT_ENGINE ? fs.realpathSync(process.env.DT_HELDOUT_ENGINE) : ENGINE_ROOT
export const VERSION = JSON.parse(fs.readFileSync(path.join(ENGINE, "package.json"), "utf8")).version
export const BIN = path.join(ENGINE, "bin", "dreamteamer.js")
export const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dt-heldout-006-")))
export const HOME = (() => {
  const h = path.join(SANDBOX, "home")
  fs.mkdirSync(h)
  return h
})()
let n = 0
export const folder = (name = "ws") => {
  const d = path.join(SANDBOX, `${++n}-${name}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}
export const cleanup = () => {
  if (!process.env.DT_KEEP_FIXTURES) fs.rmSync(SANDBOX, { recursive: true, force: true })
}

/** No registry, no operator: a closed port, a sandbox cache, a temp HOME, a synthetic git identity. */
export const ENV = {
  PATH: process.env.PATH,
  HOME,
  GIT_AUTHOR_NAME: "held-out",
  GIT_AUTHOR_EMAIL: "held-out@example.invalid",
  GIT_COMMITTER_NAME: "held-out",
  GIT_COMMITTER_EMAIL: "held-out@example.invalid",
  GIT_CEILING_DIRECTORIES: path.dirname(SANDBOX),
  npm_config_registry: "http://127.0.0.1:9/",
  npm_config_cache: path.join(SANDBOX, "npm-cache"),
  npm_config_fetch_retries: "0",
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
  npm_config_audit: "false",
  npm_config_fund: "false",
}
/** The real CLI, no TTY. Never throws on a non-zero exit. */
export function dt(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...ENV, ...env },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS * 3,
    killSignal: "SIGKILL",
  })
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}
export const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...ENV },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
export const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"))
export const readPkg = root => readJson(path.join(root, "package.json"))
export const writePkg = (root, pkg) =>
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg, null, "\t") + "\n")

/** A folder whose engine is declared and linked to this checkout, so init and install run no npm for it.
 *  `spec` is the declaration: the exact version (init's own form) or `file:<checkout>` (what npm needs
 *  when it will install a tarball beside it). */
export function withEngine(root, { spec = VERSION, extra = {} } = {}) {
  writePkg(root, {
    name: path.basename(root),
    private: true,
    ...extra,
    dependencies: { dreamteamer: spec, ...(extra.dependencies ?? {}) },
  })
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true })
  fs.symlinkSync(ENGINE, path.join(root, "node_modules", "dreamteamer"), "dir")
  return root
}
/** An initialized, committed workspace — `dt init` on a folder that already links the engine. */
export function initialized(opts = {}) {
  const root = withEngine(folder(opts.name ?? "ws"), opts)
  const r = dt(root, ["init", ...(opts.args ?? [])])
  if (r.code !== 0) throw new Error(`init failed: ${r.stderr}${r.stdout}`)
  return root
}

/** Pack packages into one folder of tarballs (what `--from` reads): each entry is a manifest, plus
 *  optional `files` ({ rel: text }). A plain package with no `dreamteamer` key is written as given. */
export function packInto(dest, packages) {
  fs.mkdirSync(dest, { recursive: true })
  for (const { files = {}, ...manifest } of packages) {
    const src = folder(`src-${manifest.name.replace(/[@/]/g, "-")}-${manifest.version}`)
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify(
        { files: ["collections", "entry.js", ...Object.keys(files).map(f => f.split("/")[0])], ...manifest },
        null,
        "\t"
      ) + "\n"
    )
    if (manifest.dreamteamer && !Object.keys(files).some(f => f.startsWith("collections/"))) {
      const id = manifest.name.replace(/^@[^/]+\//, "").replace(/[^a-z0-9]/g, "") + "s"
      files[`collections/${id}.collection.yaml`] =
        `name: ${id}\ndescription: "${manifest.name}'s records."\nfields:\n  name:\n    type: string\n    description: The name.\n`
    }
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true })
      fs.writeFileSync(path.join(src, rel), text)
    }
    const r = spawnSync("npm", ["pack", src, "--pack-destination", dest, "--silent"], {
      encoding: "utf8",
      env: { ...process.env, ...ENV },
      timeout: 60_000,
    })
    if (r.status !== 0) throw new Error(`npm pack ${manifest.name} failed: ${r.stderr}`)
  }
  return dest
}

/**
 * A synthetic setup package built to order: one unit whose inputs are `inputs` (the contract's shape),
 * one check (`<unit>.home`: configured when the home folder exists), one safe action `make-home`
 * (workspace-files: writes `<envKey>=<home>` into .env and creates the folder) that is `needs-input` while a
 * required input is missing, and an apply log (JSON lines of { action, inputs }) under the unit's receipt
 * dir — so a test can read exactly what the engine handed the unit.
 */
export function setupPackage({ name, unit, inputs, env = [], vars = [], homeInput = "home", homeKey = "PROBE_HOME" }) {
  const src = folder(`pkg-${unit}`)
  fs.writeFileSync(
    path.join(src, "package.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        type: "module",
        files: ["entry.js"],
        dreamteamer: { extension: "./entry.js", env, vars },
      },
      null,
      "\t"
    ) + "\n"
  )
  fs.writeFileSync(
    path.join(src, "entry.js"),
    `
import fs from 'node:fs';
import path from 'node:path';
export const apiVersion = 1;
const UNIT = ${JSON.stringify(unit)}, INPUTS = ${JSON.stringify(inputs)}, HOME_INPUT = ${JSON.stringify(homeInput)}, KEY = ${JSON.stringify(homeKey)};
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const envFile = (ctx) => path.join(ctx.root, '.env');
const readEnv = (ctx) => (exists(envFile(ctx)) ? fs.readFileSync(envFile(ctx), 'utf8') : '');
const homeOf = (ctx, inputs = {}) => inputs[HOME_INPUT] ?? ctx.env?.[KEY] ?? null;
const log = (ctx, entry) => { fs.mkdirSync(ctx.receiptDir, { recursive: true }); fs.appendFileSync(path.join(ctx.receiptDir, 'apply.log'), JSON.stringify(entry) + '\\n'); };
function inspect(ctx) {
	const home = homeOf(ctx);
	return { checks: [{ id: UNIT + '.home', status: home && exists(home) ? 'configured' : 'missing', title: 'home', detail: home ? (exists(home) ? 'the folder exists' : 'no folder yet') : KEY + ' is unset', fix: 'dt setup ' + UNIT }] };
}
function plan(ctx, inputs = {}) {
	const { checks } = inspect(ctx);
	const needs = INPUTS.filter((i) => i.required && inputs[i.id] === undefined).map((i) => i.id);
	const home = homeOf(ctx, inputs);
	const done = home && new RegExp('^' + KEY + '=' + home.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '$', 'm').test(readEnv(ctx)) && exists(home);
	const action = { id: 'make-home', title: 'write ' + KEY + ' into .env and create the folder', effects: [{ kind: 'workspace-files', detail: '.env: ' + KEY + ' only' }], runBy: 'engine',
		command: ['dt', 'setup', UNIT, ...needs.flatMap((id) => ['--input', id + '=<value>'])], state: needs.length ? 'needs-input' : done ? 'done' : 'ready' };
	return { checks, actions: [action], needs };
}
function apply(ctx, action, inputs = {}) {
	log(ctx, { action: action.id, inputs });
	if (action.id !== 'make-home') return { ok: false, changed: [], message: 'unknown action ' + action.id };
	const home = homeOf(ctx, inputs);
	if (!home) return { ok: false, changed: [], message: 'no home' };
	const text = readEnv(ctx);
	const re = new RegExp('^' + KEY + '=.*$', 'm');
	const out = re.test(text) ? text.replace(re, KEY + '=' + home) : text + (text && !text.endsWith('\\n') ? '\\n' : '') + KEY + '=' + home + '\\n';
	fs.writeFileSync(envFile(ctx), out);
	fs.mkdirSync(home, { recursive: true });
	return { ok: true, changed: ['.env'], message: 'wrote .env' };
}
export default function activate() { return { setup: [{ id: UNIT, version: 1, inputs: INPUTS, inspect, plan, apply }] }; }
`
  )
  return src
}

/** Put a package folder into a workspace's node_modules under its name and declare it — the way npm would
 *  have — so a test that is about setup or compile never runs npm. */
export function installPackage(root, src) {
  const pkg = readJson(path.join(src, "package.json"))
  const dest = path.join(root, "node_modules", pkg.name)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
  const ws = readPkg(root)
  ws.dependencies = { ...ws.dependencies, [pkg.name]: pkg.version }
  writePkg(root, ws)
  return dest
}

/** The apply log a `setupPackage` unit wrote in a workspace, as objects. */
export const applyLog = (root, unit) => {
  const f = path.join(root, ".dreamteamer", "setup", unit, "apply.log")
  return fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []
}

/**
 * Drive the CLI through a pseudo-terminal (python3's pty), so stdin and stdout are both TTYs. `answers`
 * is a list of { when: <substring of the output so far>, send: <text> | 'EOF' }. With `stdinPipe`, stdin is
 * a closed pipe while stdout stays the pty — the "TTY stdout, non-TTY stdin" case. Returns { code, out }.
 */
export function pty(cwd, args, { answers = [], env = {}, stdinPipe = false } = {}) {
  const driver = path.join(SANDBOX, "pty-driver.py")
  if (!fs.existsSync(driver))
    fs.writeFileSync(
      driver,
      `
import os, pty, sys, select, time, json
cmd = json.loads(sys.argv[1]); answers = json.loads(sys.argv[2]); cwd = sys.argv[3]; stdin_pipe = sys.argv[4] == '1'
r, w = os.pipe() if stdin_pipe else (None, None)
pid, fd = pty.fork()
if pid == 0:
    if stdin_pipe:
        os.dup2(r, 0); os.close(w)
    os.chdir(cwd)
    os.execvpe(cmd[0], cmd, os.environ)
if stdin_pipe:
    os.close(r); os.close(w)
out = b''; i = 0; deadline = time.time() + 90
while True:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        out += data
    if i < len(answers) and answers[i]['when'].encode() in out:
        os.write(fd, b'\\x04' if answers[i]['send'] == 'EOF' else answers[i]['send'].encode()); i += 1
    if time.time() > deadline:
        os.kill(pid, 9); break
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
`
    )
  const r = spawnSync(
    "python3",
    [driver, JSON.stringify([process.execPath, BIN, ...args]), JSON.stringify(answers), cwd, stdinPipe ? "1" : "0"],
    { env: { ...ENV, ...env }, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" }
  )
  return { code: r.status, out: (r.stdout ?? "").replace(/\r/g, ""), err: r.stderr ?? "" }
}
