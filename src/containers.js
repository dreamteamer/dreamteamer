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
	DT_REGISTRY: 'dreamteamer', // `<registry>/<template>:<tag>` is the image a template name resolves to
	DT_TEMPLATE_TAG: 'latest',
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
export function api(method, urlPath, body, { onLine } = {}) {
	const sock = socketPath();
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const req = http.request({
			socketPath: sock, method, path: urlPath,
			headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
		}, (res) => {
			let text = '';
			let pending = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => {
				text += chunk;
				if (!onLine) return;
				pending += chunk;
				const lines = pending.split('\n');
				pending = lines.pop();
				for (const l of lines) if (l.trim()) { try { onLine(JSON.parse(l)); } catch { /* not JSON */ } }
			});
			res.on('end', () => {
				const isJson = /json/.test(res.headers['content-type'] ?? '');
				let parsed = text;
				if (isJson && !onLine) { try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; } }
				resolve({ status: res.statusCode, body: parsed });
			});
		});
		req.on('error', (e) => reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? unreachable(sock) : e));
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

const LABEL = { workspace: 'dreamteamer.workspace', template: 'dreamteamer.template', person: 'dreamteamer.person', ports: 'dreamteamer.ports', modules: 'dreamteamer.modules' };
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
const editorUrl = (port) => `http://localhost:${port}/?folder=/workspace`;
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
	const mounts = Object.fromEntries((c.Mounts ?? []).filter((m) => m.Type === 'volume').map((m) => [m.Destination, m.Name]));
	return {
		name: c.Name.replace(/^\//, ''), id: c.Id.slice(0, 12),
		template: c.Config.Labels[LABEL.template] ?? '', image: c.Config.Image,
		state: c.State?.Status, started: c.State?.StartedAt, restarts: c.RestartCount ?? 0,
		bind: binding?.HostIp ?? '', port: binding ? Number(binding.HostPort) : undefined,
		editor_url: binding ? editorUrl(binding.HostPort) : '',
		volumes: { workspace: mounts['/workspace'] ?? '', home: mounts['/home/node'] ?? '', files: mounts['/files'] ?? '' },
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
 *  the same URL. Never injects a token — the person logs in INSIDE, once, and the home volume keeps it. */
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
		const body = {
			Image: ref,
			Labels: { [LABEL.workspace]: name, [LABEL.template]: template, [LABEL.person]: who.name },
			Env: [
				`DT_WORKSPACE=${name}`, `DT_TEMPLATE=${template}`, 'FILES_FOLDER=/files',
				...(who.name ? [`GIT_AUTHOR_NAME=${who.name}`, `GIT_COMMITTER_NAME=${who.name}`] : []),
				...(who.email ? [`GIT_AUTHOR_EMAIL=${who.email}`, `GIT_COMMITTER_EMAIL=${who.email}`] : []),
			],
			ExposedPorts: { [`${inner}/tcp`]: {} },
			HostConfig: {
				PortBindings: { [`${inner}/tcp`]: [{ HostIp: env.DT_BIND, HostPort: String(port) }] },
				Mounts: [
					{ Type: 'volume', Source: vols.workspace, Target: '/workspace' },
					{ Type: 'volume', Source: vols.home, Target: '/home/node' },
					{ Type: 'volume', Source: vols.files, Target: '/files' },
				],
				RestartPolicy: { Name: 'unless-stopped' },
			},
		};
		ok(await api('POST', `/containers/create?name=${encodeURIComponent(name)}`, body), `create container ${name}`);
		c = await inspectContainer(name);
		log(`✔ created ${name} from ${ref} · ${env.DT_BIND}:${port} → ${inner} · volumes ${Object.values(vols).join(', ')}`);
	}
	if (c.State?.Status !== 'running') {
		const res = await api('POST', `/containers/${c.Id}/start`);
		if (res.status !== 204 && res.status !== 304) ok(res, `start container ${name}`);
		c = await inspectContainer(name);
	}
	const detail = containerDetail(c);
	await waitHealthy(detail, log);
	log(`✔ container ${name} · ${detail.state} · ${detail.editor_url}`);
	if (!flags['no-open'] && detail.editor_url) openUrl(detail.editor_url);
	return detail;
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

function openUrl(url) {
	const cmd = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
	try { spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true }).unref(); } catch { /* printing the URL is the contract; opening it is a courtesy */ }
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
	const named = Object.values(vols).filter(Boolean);
	if (force) {
		for (const v of named) { const r = await api('DELETE', `/volumes/${encodeURIComponent(v)}`); if (r.status !== 204 && r.status !== 404) ok(r, `rm volume ${v}`); }
		log(`✔ removed ${name} and its volumes ${named.join(', ')}`);
	} else {
		log(`✔ removed ${name} · kept volumes ${named.join(', ')} (dt rm container ${name} --force removes them too; dt start container ${name} --template <t> reattaches them)`);
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
	if (verb === 'open') { const c = await inspectContainer(id); if (!c) throw new Error(`no container "${id}"`); const d = containerDetail(c); if (!d.editor_url) throw new Error(`${id} publishes no port`); console.log(d.editor_url); if (!flags['no-open']) openUrl(d.editor_url); return 0; }
	if (verb === 'rm') { await removeContainer(id, { force: flags.force === true }); return 0; }
	return 1;
}

/** A local flag parser: `--k v`, `--k=v`, bare `--k` → true. Kept here rather than importing the
 *  record parser's promotion rules — a repeated flag on these verbs is a mistake, not an array. */
export function parseFlags(args) {
	const flags = {}; const pos = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith('--')) { pos.push(a); continue; }
		const eq = a.indexOf('=');
		if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
		else if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[a.slice(2)] = args[++i];
		else flags[a.slice(2)] = true;
	}
	return { flags, pos };
}

export const CONTAINER_FLAGS = ['template', 'name', 'email', 'no-open', 'json', 'force'];
