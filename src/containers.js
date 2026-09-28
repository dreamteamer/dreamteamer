// containers.js — `containers` and `images` as verbs over the Docker Engine API. The one storage
// DRIVER in core: a workspace becomes a running container (`dt start container <name> --template
// <t>`), the person opens code-server at a loopback URL, and the same record verbs — list · get ·
// add · rm — answer over Docker instead of over a folder of files.
//
// WHY THIS IS CORE AND NOT A MODULE. A module ships collections, skills, commands and views INTO a
// workspace; every one of them needs a compiled runtime to exist. This runs BEFORE any workspace
// exists — `npm i -g dreamteamer && dt setup && dt start container …` on a machine with nothing
// but Docker Desktop — and a module has no place to stand there. That is the "could a module do it"
// question, answered: no, because the thing being made IS the workspace.
//
// WHY THERE IS NO DEPENDENCY. The Engine API is HTTP over a Unix socket (a named pipe on Windows),
// and `node:http` takes `socketPath`. Measured 2026-09-24 against Docker Desktop 29.3.1 / API 1.54:
// /version, /containers/json and /images/json all answered from a bare `node -e`. The ONE call the
// API makes awkward is `POST /build`, which wants a tar stream Node core cannot produce — so
// templates ship PREBUILT (a registry pull is `POST /images/create`, streamed JSON lines) and a
// local build is the `docker` CLI Docker Desktop installs anyway, never this file.
//
// WHAT A DRIVER COLLECTION IS NOT. Not records: nothing under `data/`, nothing `dt commit` sees,
// nothing `dt check` reads, no history (Docker keeps its own). It is not compiled into
// `.dreamteamer/collections` either — these two nouns resolve HERE, ahead of workspace discovery,
// so `dt list containers` answers identically inside a workspace and on a bare host.
//
// EVERY REQUEST CARRIES A TIMER. Docker Desktop paused, or still starting, ACCEPTS the socket and
// says nothing — and a client with no timer then hangs every verb, and everything waiting on it,
// forever (measured 2026-09-24: a fake that accepts and never answers held `dt list containers`
// until the harness killed it at 20 s). So `api()` sets an IDLE timer of `DT_DOCKER_TIMEOUT`
// seconds (default 30, host `.env` or env) on the socket: idle, not total, so a pull that keeps
// streaming progress lines is never cut off, while a silent daemon fails the verb with the knob
// named. `DT_HEALTH_TIMEOUT` (default 90) bounds the other wait, code-server's /healthz.
//
// TEST KNOBS, stated once: `DT_DOCKER_SOCKET` points the client at any socket (a fake in tests);
// `DT_HOME` relocates `~/.dreamteamer`; `DT_HEALTH_TIMEOUT=0` skips the wait for code-server's
// /healthz. None is documented in help — they are how the suite drives this file without Docker.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { parseEnvValues } from './env-vars.js';
import { emit } from './collections-cli.js';

// ---- the two nouns, singular and plural --------------------------------------------------------
// The operator's spelling is `dt start container hq-dana` and `dt list containers`; both resolve.
// This is the singular map for the driver collections ONLY — the general rule ("every record verb
// accepts the singular, derived from the descriptor") is a filed feature, not this file's job.
export const NOUNS = { containers: 'containers', container: 'containers', images: 'images', image: 'images' };
export const DRIVER_VERBS = new Set(['list', 'get', 'add', 'rm', 'start', 'stop', 'open']);
export const LIFECYCLE_VERBS = new Set(['start', 'stop', 'open']);

/** `containers`, `container`, `containers/<id>` → { collection, id }; null when the word is not ours. */
export function driverTarget(word) {
	if (!word || word.startsWith('--')) return null;
	const slash = word.indexOf('/');
	const noun = slash === -1 ? word : word.slice(0, slash);
	const collection = NOUNS[noun];
	if (!collection) return null;
	return { collection, id: slash === -1 ? undefined : word.slice(slash + 1) };
}

// ---- host configuration: ~/.dreamteamer/.env ---------------------------------------------------
export const HOST_DEFAULTS = {
	DT_PORT_BASE: '8100',       // NOT 8080: that is code-server's in-container port, `dt start`'s REST default, and the old dev image's exposed port — three things on one number
	DT_BIND: '127.0.0.1',       // loopback only; a remote tier puts auth in front before this changes
	DT_REGISTRY: 'ghcr.io/dreamteamer', // `<registry>/<template>:<tag>` is the image a template name resolves to — the public images repo publishes here
	DT_TEMPLATE_TAG: 'latest',
	DT_DOCKER_TIMEOUT: '30',    // seconds a request to Docker may sit IDLE before the verb fails — see the header
};

export function hostDir() { return process.env.DT_HOME ?? path.join(os.homedir(), '.dreamteamer'); }

/** Defaults, then the file, then the process env — the same precedence a shell would give. */
export function hostEnv() {
	const file = path.join(hostDir(), '.env');
	// parseEnvValues answers a Map — spread it as entries, or the file silently contributes nothing.
	const fromFile = fs.existsSync(file) ? Object.fromEntries(parseEnvValues(fs.readFileSync(file, 'utf8'))) : {};
	const out = { ...HOST_DEFAULTS, ...fromFile };
	for (const k of Object.keys(process.env)) if (k.startsWith('DT_') && process.env[k] !== undefined) out[k] = process.env[k];
	return out;
}

// ---- the Engine API client ---------------------------------------------------------------------
export function socketPath() {
	if (process.env.DT_DOCKER_SOCKET) return process.env.DT_DOCKER_SOCKET;
	if (process.platform === 'win32') return '//./pipe/docker_engine';
	for (const p of ['/var/run/docker.sock', path.join(os.homedir(), '.docker', 'run', 'docker.sock')]) {
		try { if (fs.statSync(p).isSocket()) return p; } catch { /* next */ }
	}
	return '/var/run/docker.sock';
}

function unreachable(sock) {
	const hint = process.platform === 'darwin' ? ' — is Docker Desktop running? `open -a Docker` starts it' : ' — is the Docker daemon running?';
	return new Error(`Docker is not reachable at ${sock}${hint}. \`dt setup\` checks this and says what is missing.`);
}

/** One request. Resolves { status, body } where body is parsed JSON when the response is JSON,
 *  else the raw text. `onLine` receives each JSON line of a streaming response (a pull). */
/** Seconds a request may sit idle before it fails; 0 disables — `DT_DOCKER_TIMEOUT`, env over file over default. */
export function dockerTimeoutSeconds() {
	const n = Number(hostEnv().DT_DOCKER_TIMEOUT);
	return Number.isFinite(n) && n >= 0 ? n : Number(HOST_DEFAULTS.DT_DOCKER_TIMEOUT);
}

export function api(method, urlPath, body, { onLine, raw } = {}) {
	const sock = socketPath();
	const seconds = dockerTimeoutSeconds();
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const req = http.request({
			socketPath: sock, method, path: urlPath,
			headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
		}, (res) => {
			let text = '';
			let pending = '';
			const bufs = []; // `raw`: an exec's multiplexed stream is binary framing, so it stays bytes
			if (!raw) res.setEncoding('utf8');
			res.on('data', (chunk) => {
				if (raw) { bufs.push(chunk); return; }
				text += chunk;
				if (!onLine) return;
				pending += chunk;
				const lines = pending.split('\n');
				pending = lines.pop();
				for (const l of lines) if (l.trim()) { try { onLine(JSON.parse(l)); } catch { /* not JSON */ } }
			});
			res.on('end', () => {
				if (raw) return resolve({ status: res.statusCode, body: Buffer.concat(bufs) });
				const isJson = /json/.test(res.headers['content-type'] ?? '');
				let parsed = text;
				if (isJson && !onLine) { try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; } }
				resolve({ status: res.statusCode, body: parsed });
			});
		});
		req.on('error', (e) => reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? unreachable(sock) : e));
		// idle-based: fires only when NOTHING has moved on the socket for `seconds` — a streaming
		// pull resets it with every progress line, a paused daemon never does
		if (seconds) req.setTimeout(seconds * 1000, () => req.destroy(new Error(`${method} ${urlPath}: Docker did not answer within ${seconds}s — is Docker Desktop paused or still starting? DT_DOCKER_TIMEOUT=<seconds> in ${path.join(hostDir(), '.env')} changes the wait (0 disables it)`)));
		if (payload) req.write(payload);
		req.end();
	});
}

/** Throw the daemon's own sentence on a non-2xx, so a refusal reads as Docker's rather than ours. */
function ok(res, what) {
	if (res.status >= 200 && res.status < 400) return res.body;
	const msg = res.body && typeof res.body === 'object' && res.body.message ? res.body.message : String(res.body ?? '').trim();
	throw new Error(`${what}: Docker answered ${res.status}${msg ? ` — ${msg}` : ''}`);
}

const LABEL = { workspace: 'dreamteamer.workspace', template: 'dreamteamer.template', person: 'dreamteamer.person', ports: 'dreamteamer.ports', modules: 'dreamteamer.modules', workdir: 'dreamteamer.workdir' };
const filters = (label) => encodeURIComponent(JSON.stringify({ label: [label] }));

// ---- images ------------------------------------------------------------------------------------
export function imageRef(template, env = hostEnv()) {
	// `DT_IMAGE_<template>=<ref>` pins one template to any image, which is how a local build or a
	// private registry is reached without the registry default changing for every other template.
	return env[`DT_IMAGE_${template}`] ?? `${env.DT_REGISTRY}/${template}:${env.DT_TEMPLATE_TAG}`;
}

const imageRow = (i) => ({
	image: (i.RepoTags ?? []).find((t) => t !== '<none>:<none>') ?? i.Id.slice(7, 19),
	template: i.Labels?.[LABEL.template] ?? '',
	ports: i.Labels?.[LABEL.ports] ?? '',
	modules: i.Labels?.[LABEL.modules] ?? '',
	size_mb: Math.round((i.Size ?? 0) / 1e6),
	created: i.Created ? new Date(i.Created * 1000).toISOString().slice(0, 10) : '',
	id: i.Id,
});

export async function listImages() {
	const body = ok(await api('GET', `/images/json?filters=${filters(LABEL.template)}`), 'list images');
	return body.map(imageRow).sort((a, b) => a.image.localeCompare(b.image));
}

export async function inspectImage(ref) {
	const res = await api('GET', `/images/${encodeURIComponent(ref)}/json`);
	return res.status === 404 ? null : ok(res, `get image ${ref}`);
}

export async function pullImage(ref, log = console.error) {
	const [name, tag] = splitTag(ref);
	let last = '';
	const res = await api('POST', `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`, undefined, {
		onLine: (l) => { if (l.status && l.status !== last) { last = l.status; log(`  … ${l.status}${l.id ? ` ${l.id}` : ''}`); } if (l.error) throw new Error(l.error); },
	});
	if (res.status !== 200) throw new Error(`pull ${ref}: Docker answered ${res.status} — ${String(res.body).trim()}. A local build is \`docker build -t ${ref} …\`, or pin DT_IMAGE_<template> in ${path.join(hostDir(), '.env')}`);
}

function splitTag(ref) {
	const at = ref.lastIndexOf(':');
	const slash = ref.lastIndexOf('/');
	return at > slash ? [ref.slice(0, at), ref.slice(at + 1)] : [ref, 'latest'];
}

// ---- containers --------------------------------------------------------------------------------
const containerRow = (c) => {
	const name = (c.Names?.[0] ?? '').replace(/^\//, '');
	const port = (c.Ports ?? []).find((p) => p.PublicPort)?.PublicPort;
	return {
		name, template: c.Labels?.[LABEL.template] ?? '', state: c.State, status: c.Status,
		editor_url: port ? editorUrl(port) : '', image: c.Image, person: c.Labels?.[LABEL.person] ?? '',
		created: c.Created ? new Date(c.Created * 1000).toISOString().slice(0, 16).replace('T', ' ') : '', id: c.Id,
	};
};
/** The dev-container convention: the workspace is mounted at `/workspaces/<name>`, so the folder the
 *  editor opens, the URL, and a VS Code attach all name the workspace rather than a fixed word. */
export const workspaceDir = (name) => `/workspaces/${name}`;
/** A bare URL opens the machine home (`/opt/dt-launcher`: every workspace, create, clone) — `?folder=`
 *  only when the caller asks for one workspace (`--workspace`). */
const editorUrl = (port, folder) => `http://localhost:${port}/${folder ? `?folder=${folder}` : ''}`;
/** Where `--mount` may land: the image's own trees. Anywhere else (`/etc`, `/usr/local/bin`, `/opt`)
 *  replaces what the image runs — a mount there is a way round the image, not a mount. */
export const MOUNT_ROOTS = ['/workspaces', '/home/node', '/files', '/mnt'];
/** `--mount <host-path|volume>:<container-path>[:ro]` → a Docker Mount. A source starting with `/`,
 *  `~` or `.` is a bind mount of a host path (resolved against cwd); anything else is a named volume. */
export function parseMount(spec) {
	const parts = String(spec).split(':');
	if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1].startsWith('/')) throw new Error(`--mount takes <host-path|volume>:<container-path>[:ro] — got "${spec}"`);
	const [src, rawTarget, mode] = parts;
	const target = path.posix.normalize(rawTarget).replace(/(.)\/$/, '$1'); // `/mnt/../etc` is `/etc`
	if (!MOUNT_ROOTS.some((r) => target === r || target.startsWith(`${r}/`))) throw new Error(`--mount "${spec}": the target must be under ${MOUNT_ROOTS.join(' · ')} — ${target} is not`);
	if (mode !== undefined && mode !== 'ro' && mode !== 'rw') throw new Error(`--mount "${spec}": the third part is ro or rw`);
	const isPath = /^[/~.]/.test(src);
	const source = isPath ? path.resolve(src.replace(/^~(?=\/|$)/, os.homedir())) : src;
	if (!isPath && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(src)) throw new Error(`--mount "${spec}": "${src}" is neither a path nor a volume name`);
	return { Type: isPath ? 'bind' : 'volume', Source: source, Target: target, ReadOnly: mode === 'ro' };
}
/** The URI VS Code on the host opens to attach to this container (Dev Containers extension). The
 *  container name is hex-encoded, as the extension spells it. */
export const attachUri = (name) => `vscode-remote://attached-container+${Buffer.from(name, 'utf8').toString('hex')}${workspaceDir(name)}`;
/** Each container gets its OWN user-defined bridge, so two workspaces on one machine cannot reach
 *  each other's ports the way two containers on Docker's default bridge can. */
export const networkName = (name) => `dreamteamer-${name}`;
const volumeNames = (name) => ({ workspace: `dreamteamer-${name}-workspace`, home: `dreamteamer-${name}-home`, files: `dreamteamer-${name}-files` });

export async function listContainers() {
	const body = ok(await api('GET', `/containers/json?all=1&filters=${filters(LABEL.workspace)}`), 'list containers');
	return body.map(containerRow).sort((a, b) => a.name.localeCompare(b.name));
}

export async function inspectContainer(name) {
	const res = await api('GET', `/containers/${encodeURIComponent(name)}/json`);
	if (res.status === 404) return null;
	const c = ok(res, `get container ${name}`);
	if (!c.Config?.Labels?.[LABEL.workspace]) throw new Error(`"${name}" is a Docker container but not a dreamteamer workspace (no ${LABEL.workspace} label) — this verb only touches containers it made`);
	return c;
}

/** The shape `dt get container <name>` prints: the categorised view over `docker inspect`. */
export function containerDetail(c) {
	const binding = Object.values(c.HostConfig?.PortBindings ?? {}).flat()[0];
	const name = c.Name.replace(/^\//, '');
	const wsDir = c.Config.Labels?.[LABEL.workdir] ?? workspaceDir(name);
	const own = new Set([wsDir, '/home/node', '/files']);
	const mounts = Object.fromEntries((c.Mounts ?? []).filter((m) => m.Type === 'volume').map((m) => [m.Destination, m.Name]));
	return {
		name, id: c.Id.slice(0, 12),
		template: c.Config.Labels[LABEL.template] ?? '', image: c.Config.Image,
		state: c.State?.Status, started: c.State?.StartedAt, restarts: c.RestartCount ?? 0,
		bind: binding?.HostIp ?? '', port: binding ? Number(binding.HostPort) : undefined,
		editor_url: binding ? editorUrl(binding.HostPort) : '',
		attach_uri: attachUri(name),
		workspace_dir: wsDir,
		volumes: { workspace: mounts[wsDir] ?? '', home: mounts['/home/node'] ?? '', files: mounts['/files'] ?? '' },
		mounts: (c.Mounts ?? []).filter((m) => !own.has(m.Destination)).map((m) => `${m.Type === 'bind' ? m.Source : m.Name}:${m.Destination}${m.RW === false ? ':ro' : ''}`),
		repo: (c.Config.Env ?? []).find((e) => e.startsWith('DT_REPO='))?.slice(8) ?? '',
		person: c.Config.Labels[LABEL.person] ?? '', created: c.Created, labels: c.Config.Labels,
	};
}

/** The lowest host port from DT_PORT_BASE upward that no dreamteamer container already holds. */
export async function allocatePort(env = hostEnv()) {
	const base = Number(env.DT_PORT_BASE);
	if (!Number.isInteger(base) || base < 1024) throw new Error(`DT_PORT_BASE must be an integer port above 1023 (got "${env.DT_PORT_BASE}")`);
	const all = ok(await api('GET', `/containers/json?all=1&filters=${filters(LABEL.workspace)}`), 'list containers');
	const taken = new Set(all.flatMap((c) => (c.Ports ?? []).map((p) => p.PublicPort)).filter(Boolean));
	// A stopped container publishes nothing in /containers/json, so read its binding from inspect —
	// otherwise the second workspace lands on the first one's port the moment the first is stopped.
	for (const c of all) if (c.State !== 'running') {
		const d = await api('GET', `/containers/${c.Id}/json`);
		for (const b of Object.values(d.body?.HostConfig?.PortBindings ?? {}).flat()) taken.add(Number(b.HostPort));
	}
	let port = base;
	while (taken.has(port)) port++;
	return port;
}

function person(flags, env) {
	const git = (k) => { try { return execFileSync('git', ['config', '--global', k], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
	const name = flags.name ?? env.DT_PERSON_NAME ?? git('user.name');
	const email = flags.email ?? env.DT_PERSON_EMAIL ?? git('user.email');
	return { name, email };
}

/** Create-if-absent and start. Idempotent: a second call on an existing name starts it and prints
 *  the same URL. Never injects a credential — the person logs in INSIDE, once, and the home volume
 *  keeps it. The one secret that crosses is the image's own URL token, read back OUT (launchUrl). */
export async function startContainer(name, flags, log = console.log) {
	if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) throw new Error(`"${name}" is not a container name — lowercase letters, digits, "-", "_" and "."; e.g. hq-dana`);
	const env = hostEnv();
	let c = await inspectContainer(name);
	if (!c) {
		const template = typeof flags.template === 'string' ? flags.template : undefined;
		if (!template) throw new Error(`container "${name}" does not exist yet — name the template that makes it: dt start container ${name} --template <t> (dt list images shows the templates present)`);
		const ref = imageRef(template, env);
		let img = await inspectImage(ref);
		if (!img) { log(`… pulling ${ref}`); await pullImage(ref, log); img = await inspectImage(ref); }
		if (!img) throw new Error(`image ${ref} is still absent after the pull`);
		const labels = img.Config?.Labels ?? {};
		const inner = Number(labels[LABEL.ports] ?? 8080);
		const port = await allocatePort(env);
		const who = person(flags, env);
		const vols = volumeNames(name);
		const wsDir = workspaceDir(name);
		// `--mount` adds bind or volume mounts beside the three the container always has; a mount aimed
		// at one of those three targets is refused rather than silently shadowing the volume.
		const extra = (flags.mount ?? []).map(parseMount);
		for (const m of extra) if ([wsDir, '/workspaces', '/home/node', '/files'].includes(m.Target)) throw new Error(`--mount cannot target ${m.Target} — that is one of the container's own volumes, or holds them (${wsDir} · /home/node · /files)`);
		// A bind whose source lies inside another bind's (or IS it) reaches the same files twice — the
		// way a `:ro` mount of a folder is undone by a writable mount of the folder it sits in.
		const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
		const binds = extra.filter((m) => m.Type === 'bind').map((m) => ({ m, real: real(m.Source) }));
		for (const a of binds) for (const b of binds) if (a !== b && !path.relative(b.real, a.real).startsWith('..')) throw new Error(`--mount ${a.m.Source}:${a.m.Target} lies inside ${b.m.Source} (mounted at ${b.m.Target}) — one container reaches a host folder through one mount`);
		// `--repo <url>` clones an EXISTING workspace into the workspace volume on first start instead of
		// laying the template down — the way a person joins a workspace that already lives on GitHub.
		const repo = typeof flags.repo === 'string' ? flags.repo : undefined;
		if (repo !== undefined && !/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(repo)) throw new Error(`--repo takes a git URL or an absolute path — got "${repo}"`);
		const body = {
			Image: ref,
			Labels: { [LABEL.workspace]: name, [LABEL.template]: template, [LABEL.person]: who.name, [LABEL.workdir]: wsDir },
			Env: [
				`DT_WORKSPACE=${name}`, `DT_TEMPLATE=${template}`, `DT_WORKSPACE_DIR=${wsDir}`, 'FILES_FOLDER=/files',
				// the editor listens on every interface INSIDE the container so the port mapping reaches
				// it; the host side stays DT_BIND (loopback) — and the image's proxy checks a token
				'DT_LOCAL_BIND=0.0.0.0',
				...(repo ? [`DT_REPO=${repo}`] : []),
				...(who.name ? [`GIT_AUTHOR_NAME=${who.name}`, `GIT_COMMITTER_NAME=${who.name}`] : []),
				...(who.email ? [`GIT_AUTHOR_EMAIL=${who.email}`, `GIT_COMMITTER_EMAIL=${who.email}`] : []),
			],
			ExposedPorts: { [`${inner}/tcp`]: {} },
			HostConfig: {
				PortBindings: { [`${inner}/tcp`]: [{ HostIp: env.DT_BIND, HostPort: String(port) }] },
				Mounts: [
					{ Type: 'volume', Source: vols.workspace, Target: wsDir },
					{ Type: 'volume', Source: vols.home, Target: '/home/node' },
					{ Type: 'volume', Source: vols.files, Target: '/files' },
					...extra,
				],
				RestartPolicy: { Name: 'unless-stopped' },
				NetworkMode: await ensureNetwork(name), // its own bridge ONLY — never the default one
			},
		};
		ok(await api('POST', `/containers/create?name=${encodeURIComponent(name)}`, body), `create container ${name}`);
		c = await inspectContainer(name);
		log(`✔ created ${name} from ${ref} · ${env.DT_BIND}:${port} → ${inner} · ${wsDir} · volumes ${Object.values(vols).join(', ')}${extra.length ? ` · mounts ${extra.map((m) => `${m.Source}→${m.Target}${m.ReadOnly ? ' (ro)' : ''}`).join(', ')}` : ''}${repo ? ` · clones ${repo} on first start` : ''}`);
	}
	if (c.State?.Status !== 'running') {
		const res = await api('POST', `/containers/${c.Id}/start`);
		if (res.status !== 204 && res.status !== 304) ok(res, `start container ${name}`);
		c = await inspectContainer(name);
	}
	const detail = containerDetail(c);
	await waitHealthy(detail, log);
	const url = await launchUrl(detail, flags);
	log(`✔ container ${name} · ${detail.state} · ${url.text}`);
	if (!flags['no-open'] && detail.port) openUrl(url, log);
	return detail;
}

async function ensureNetwork(name) {
	const net = networkName(name);
	const res = await api('GET', `/networks/${encodeURIComponent(net)}`);
	if (res.status === 404) { ok(await api('POST', '/networks/create', { Name: net, Driver: 'bridge', Labels: { dreamteamer: '1', 'dreamteamer.name': name } }), `create network ${net}`); return net; }
	if (ok(res, `get network ${net}`).Labels?.['dreamteamer.name'] !== name) throw new Error(`a Docker network "${net}" exists that dreamteamer did not make — remove or rename it (docker network rm ${net})`);
	return net;
}

/** Run `cmd` (an argv, never a shell line) in a running container as `user` — one Docker exec under
 *  the same idle timer as every request. Answers { code, stdout, stderr }; a non-zero exit is the
 *  caller's to judge. */
export async function exec(name, cmd, { user } = {}) {
	const what = `exec ${cmd[0]} in ${name}`;
	const { Id } = ok(await api('POST', `/containers/${encodeURIComponent(name)}/exec`, { Cmd: cmd, AttachStdout: true, AttachStderr: true, ...(user ? { User: user } : {}) }), what);
	const res = await api('POST', `/exec/${Id}/start`, { Detach: false, Tty: false }, { raw: true });
	ok({ status: res.status, body: res.body.toString('utf8') }, what);
	// Tty:false answers Docker's multiplexed stream: per frame an 8-byte header — stream (1 out, 2 err),
	// three zero bytes, a big-endian length — then that many bytes
	const out = { stdout: '', stderr: '' };
	for (let b = res.body, i = 0, n; i + 8 <= b.length; i += 8 + n) { n = b.readUInt32BE(i + 4); out[b[i] === 2 ? 'stderr' : 'stdout'] += b.subarray(i + 8, i + 8 + n).toString('utf8'); }
	return { code: ok(await api('GET', `/exec/${Id}/json`), what).ExitCode, ...out };
}

/** The URL to print and open. An image that lists `url-token` in /opt/dt-image/features (hq 0.6+)
 *  holds a secret its proxy checks; it is read by exec as root, lives in this process only, and
 *  reaches the person as `?tkn=` on the ONE line that prints the URL. An older image has no file and
 *  gets the plain URL. `text` is that line's URL; `secret` says the token rides on it. */
async function launchUrl(detail, flags) {
	const folder = flags.workspace === true ? detail.workspace_dir : typeof flags.workspace === 'string' ? workspaceDir(flags.workspace) : undefined;
	if (folder && !/^\/workspaces\/[a-z0-9][a-z0-9_.-]*$/.test(folder)) throw new Error(`--workspace takes a workspace folder name under /workspaces — got "${flags.workspace}"`);
	const plain = detail.port ? editorUrl(detail.port, folder) : '';
	const features = await exec(detail.name, ['cat', '/opt/dt-image/features']);
	const tokened = features.code === 0 && features.stdout.split('\n').some((l) => l.trim() === 'url-token');
	const rotate = flags['rotate-token'] === true;
	if (!tokened) {
		if (rotate) throw new Error(`${detail.name} runs an image with no URL token (no url-token in /opt/dt-image/features) — --rotate-token needs hq 0.6 or later`);
		return { text: plain, secret: false };
	}
	const r = await exec(detail.name, ['dt-url-token', rotate ? 'rotate' : 'show'], { user: 'root' });
	const token = r.stdout.trim();
	if (r.code !== 0 || !/^[A-Za-z0-9_-]{16,}$/.test(token)) throw new Error(`dt-url-token ${rotate ? 'rotate' : 'show'} in ${detail.name} failed (exit ${r.code})${r.stderr.trim() ? ` — ${r.stderr.trim()}` : ''}`);
	return { text: `${plain}${folder ? '&' : '?'}tkn=${token}`, secret: true };
}

/** Poll code-server's /healthz so the URL printed is one that already answers. */
async function waitHealthy(detail, log) {
	const seconds = process.env.DT_HEALTH_TIMEOUT !== undefined ? Number(process.env.DT_HEALTH_TIMEOUT) : 90;
	if (!seconds || !detail.port) return;
	const until = Date.now() + seconds * 1000;
	let told = false;
	while (Date.now() < until) {
		const up = await new Promise((r) => {
			const req = http.get({ host: detail.bind || '127.0.0.1', port: detail.port, path: '/healthz', timeout: 2000 }, (res) => { res.resume(); r(res.statusCode < 500); });
			req.on('error', () => r(false)); req.on('timeout', () => { req.destroy(); r(false); });
		});
		if (up) return;
		if (!told) { log('… waiting for the editor to answer (first start compiles the workspace)'); told = true; }
		await new Promise((r) => setTimeout(r, 1500));
	}
	log(`⚠ the editor did not answer within ${seconds}s — \`docker logs ${detail.name}\` says why`);
}

/** Printing the URL is the contract; opening it is a courtesy. A tokened URL never becomes a process
 *  ARGUMENT (every local user's `ps` reads those): on macOS it reaches `osascript` on stdin; where no
 *  opener takes stdin (xdg-open, start) it is printed and left for the person to open. */
function openUrl({ text, secret }, log) {
	try {
		if (secret && process.platform === 'darwin') {
			const p = spawn('osascript', ['-'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
			p.on('error', () => {}); p.stdin.end(`open location "${text}"\n`); p.unref(); return;
		}
		if (secret) { log('  (open the URL above yourself — this platform\'s opener would put the token in a process argument)'); return; }
		const cmd = process.platform === 'darwin' ? ['open', text] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', text] : ['xdg-open', text];
		spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
	} catch { /* the URL is printed either way */ }
}

export async function stopContainer(name) {
	const c = await inspectContainer(name);
	if (!c) throw new Error(`no container "${name}" — dt list containers`);
	const res = await api('POST', `/containers/${c.Id}/stop?t=10`);
	if (res.status !== 204 && res.status !== 304) ok(res, `stop container ${name}`);
	return containerDetail(await inspectContainer(name));
}

/** Plain `rm` keeps the three volumes — the workspace, the login, the files. `--force` removes them too. */
export async function removeContainer(name, { force = false } = {}, log = console.log) {
	const c = await inspectContainer(name);
	if (!c) throw new Error(`no container "${name}" — dt list containers`);
	const vols = containerDetail(c).volumes;
	if (c.State?.Status === 'running') await api('POST', `/containers/${c.Id}/stop?t=10`);
	ok(await api('DELETE', `/containers/${c.Id}?v=false`), `rm container ${name}`);
	const net = await api('GET', `/networks/${encodeURIComponent(networkName(name))}`);
	if (net.status === 200 && net.body?.Labels?.['dreamteamer.name'] === name) ok(await api('DELETE', `/networks/${encodeURIComponent(networkName(name))}`), `rm network ${networkName(name)}`);
	const named = Object.values(vols).filter(Boolean);
	if (force) {
		for (const v of named) { const r = await api('DELETE', `/volumes/${encodeURIComponent(v)}`); if (r.status !== 204 && r.status !== 404) ok(r, `rm volume ${v}`); }
		log(`✔ removed ${name}, its network and its volumes ${named.join(', ')}`);
	} else {
		log(`✔ removed ${name} and its network · kept volumes ${named.join(', ')} (dt rm container ${name} --force removes them too; dt start container ${name} --template <t> reattaches them)`);
	}
}

// ---- setup: the host's board -------------------------------------------------------------------
export async function setup(flags, log = console.log) {
	const dir = hostDir();
	const file = path.join(dir, '.env');
	fs.mkdirSync(dir, { recursive: true });
	const existing = fs.existsSync(file) ? Object.fromEntries(parseEnvValues(fs.readFileSync(file, 'utf8'))) : {};
	const missing = Object.entries(HOST_DEFAULTS).filter(([k]) => !(k in existing));
	if (missing.length) {
		const header = fs.existsSync(file) ? '' : '# dreamteamer host configuration — read by `dt setup`, `dt start container` and friends.\n# DT_IMAGE_<template>=<ref> pins a template to an image; DT_PERSON_NAME / DT_PERSON_EMAIL are the git identity containers get.\n';
		fs.appendFileSync(file, header + missing.map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
	}
	const board = [];
	board.push(`host env    ${file} · ${missing.length ? `${missing.length} default(s) written` : 'present'}`);
	let docker;
	try {
		const v = ok(await api('GET', '/version'), 'docker version');
		docker = `docker      ${v.Version} · api ${v.ApiVersion} · ${v.Os}/${v.Arch} · ${socketPath()}`;
	} catch (e) {
		board.push(`docker      ✖ ${e.message}`);
		for (const l of board) log(l);
		return 1;
	}
	board.push(docker);
	const images = await listImages();
	board.push(`templates   ${images.length ? images.map((i) => `${i.template} (${i.image})`).join(', ') : 'none present — dt add image --template <t> pulls one'}`);
	const template = typeof flags.template === 'string' ? flags.template : undefined;
	if (template) {
		const ref = imageRef(template);
		if (!(await inspectImage(ref))) { log(`… pulling ${ref}`); await pullImage(ref, log); board.push(`pulled      ${ref}`); } else board.push(`present     ${ref}`);
	}
	const running = (await listContainers()).filter((c) => c.state === 'running');
	board.push(`containers  ${running.length} running${running.length ? ' — ' + running.map((c) => `${c.name} ${c.editor_url}`).join(', ') : ''}`);
	for (const l of board) log(l);
	return 0;
}

// ---- the verb surface `cli.js` hands over ------------------------------------------------------
const table = (rows, cols) => {
	if (!rows.length) return '(none)';
	const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
	return rows.map((r) => cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  ').trimEnd()).join('\n');
};

/** `dt <verb> <container|containers|image|images>[/<id>] [<id>] [flags]` → exit code. */
export async function driverCommand(verb, target, args) {
	const { flags, pos } = parseFlags(args);
	const id = target.id ?? pos[0];
	const json = flags.json === true;
	const col = target.collection;
	if (!DRIVER_VERBS.has(verb)) throw new Error(`\`${verb}\` is not a verb on ${col} — list · get · add · rm${col === 'containers' ? ' · start · stop · open' : ''}`);
	if (col === 'images') {
		if (LIFECYCLE_VERBS.has(verb)) throw new Error(`\`${verb}\` is a container verb — an image is started by starting a container from it: dt start container <name> --template <t>`);
		if (verb === 'list') { const rows = await listImages(); json ? emit(JSON.stringify(rows, null, 2)) : console.log(table(rows, ['template', 'image', 'size_mb', 'ports', 'created'])); return 0; }
		if (verb === 'get') { if (!id) throw new Error('dt get image <ref>'); const i = await inspectImage(id); if (!i) throw new Error(`no image "${id}"`); emit(JSON.stringify(json ? i : imageRow({ ...i, Labels: i.Config?.Labels, Created: Date.parse(i.Created) / 1000 }), null, 2)); return 0; }
		if (verb === 'add') { const t = typeof flags.template === 'string' ? flags.template : undefined; if (!t) throw new Error('dt add image --template <t> pulls the template\'s image'); const ref = imageRef(t); console.log(`… pulling ${ref}`); await pullImage(ref); console.log(`✔ ${ref}`); return 0; }
		if (verb === 'rm') { if (!id) throw new Error('dt rm image <ref>'); ok(await api('DELETE', `/images/${encodeURIComponent(id)}${flags.force ? '?force=true' : ''}`), `rm image ${id}`); console.log(`✔ removed image ${id}`); return 0; }
	}
	// containers
	if (verb === 'list') { const rows = await listContainers(); json ? emit(JSON.stringify(rows, null, 2)) : console.log(table(rows, ['name', 'template', 'state', 'editor_url', 'person', 'created'])); return 0; }
	if (!id) throw new Error(`dt ${verb} container <name>${verb === 'start' || verb === 'add' ? ' --template <t>' : ''}`);
	if (verb === 'get') { const c = await inspectContainer(id); if (!c) throw new Error(`no container "${id}" — dt list containers`); emit(JSON.stringify(json ? c : containerDetail(c), null, 2)); return 0; }
	if (verb === 'start' || verb === 'add') { const d = await startContainer(id, flags); if (json) emit(JSON.stringify(d, null, 2)); return 0; }
	if (verb === 'stop') { const d = await stopContainer(id); console.log(`✔ stopped ${id} · volumes kept`); if (json) emit(JSON.stringify(d, null, 2)); return 0; }
	if (verb === 'open') {
		const c = await inspectContainer(id); if (!c) throw new Error(`no container "${id}"`);
		const d = containerDetail(c);
		if (flags.vscode) {
			// Dev Containers attach: the host's own VS Code opens the workspace INSIDE the container, and
			// installs the extensions the image's `devcontainer.metadata` label names into the container's
			// VS Code Server — a second extension host beside code-server's, over the same files.
			console.log(d.attach_uri);
			if (!flags['no-open']) { try { spawn('code', ['--folder-uri', d.attach_uri], { stdio: 'ignore', detached: true }).unref(); } catch { /* the URI is printed either way */ } }
			return 0;
		}
		if (!d.editor_url) throw new Error(`${id} publishes no port`);
		if (d.state !== 'running') throw new Error(`${id} is ${d.state} — dt start container ${id} starts it and prints its URL`);
		const url = await launchUrl(d, flags);
		console.log(url.text); if (!flags['no-open']) openUrl(url, console.log); return 0;
	}
	if (verb === 'rm') { await removeContainer(id, { force: flags.force === true }); return 0; }
	return 1;
}

/** A local flag parser: `--k v`, `--k=v`, bare `--k` → true. Kept here rather than importing the
 *  record parser's promotion rules — a repeated flag on these verbs is a mistake, not an array. */
export function parseFlags(args) {
	const flags = {}; const pos = [];
	// `--mount` is the one flag that repeats — every other repeat is a mistake and the LAST wins.
	const put = (k, v) => { if (k === 'mount') flags.mount = [...(flags.mount ?? []), v]; else flags[k] = v; };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith('--')) { pos.push(a); continue; }
		const eq = a.indexOf('=');
		if (eq > -1) put(a.slice(2, eq), a.slice(eq + 1));
		else if (i + 1 < args.length && !args[i + 1].startsWith('--')) put(a.slice(2), args[++i]);
		else put(a.slice(2), true);
	}
	return { flags, pos };
}

export const CONTAINER_FLAGS = ['template', 'name', 'email', 'no-open', 'json', 'force', 'mount', 'repo', 'vscode', 'rotate-token', 'workspace'];
