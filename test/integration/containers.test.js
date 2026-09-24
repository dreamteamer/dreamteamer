// The Docker driver, driven through the real CLI binary against a fake Engine API on a Unix socket.
// Every assertion is about BEHAVIOUR the operator's four lines depend on — what the create body
// carries, which port the second workspace gets, that a token never travels — not about a code
// path being reached. No Docker is needed to run this file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { ENGINE_ROOT, twoModuleWorkspace } from '../helpers/ws.js';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const FAKE = path.join(ENGINE_ROOT, 'test', 'helpers', 'fake-docker.js');
const HQ = 'ghcr.io/dreamteamer/hq:latest';

/** The fake Engine API as a CHILD process (see fake-docker.js for why), with its recorded state
 *  readable over the socket between the spawnSync calls that drive the CLI. */
function startFakeDocker(sock, { images = [], plain = [] } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [FAKE, sock, JSON.stringify(images), JSON.stringify(plain)], { stdio: ['ignore', 'pipe', 'inherit'] });
		child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(handle); });
		child.on('exit', (code) => reject(new Error(`fake docker exited ${code}`)));
		const state = () => new Promise((ok, no) => {
			const req = http.get({ socketPath: sock, path: '/_fake/state' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok(JSON.parse(b))); });
			req.on('error', no);
		});
		const handle = { state, close: () => new Promise((ok) => { child.once('exit', () => ok()); child.kill(); }) };
	});
}

function harness(images = [{ ref: HQ, labels: { 'dreamteamer.template': 'hq', 'dreamteamer.ports': '8080', 'dreamteamer.modules': 'users,contacts' } }]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-fd-'));
	const sock = path.join(dir, 'd.sock');
	const home = path.join(dir, 'home');
	const bare = path.join(dir, 'bare'); // a directory with NO workspace above it that git could find
	fs.mkdirSync(bare, { recursive: true });
	const env = { ...process.env, DT_DOCKER_SOCKET: sock, DT_HOME: home, DT_HEALTH_TIMEOUT: '0', DT_PERSON_NAME: 'Test Person', DT_PERSON_EMAIL: 'test@example.invalid' };
	const dt = (...args) => {
		const r = spawnSync(process.execPath, [BIN, ...args], { cwd: bare, env, encoding: 'utf8' });
		return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
	};
	return { dir, sock, home, env, dt, images };
}

describe('host mode — the verbs answer with NO workspace', () => {
	let h, fake;
	before(async () => { h = harness(); fake = await startFakeDocker(h.sock, { images: h.images, plain: ['plain-nginx'] }); });
	after(async () => { await fake.close(); fs.rmSync(h.dir, { recursive: true, force: true }); });

	test('list containers on a bare host prints (none) at exit 0, and --json prints [] — a plain Docker container is invisible', () => {
		const r = h.dt('list', 'containers');
		assert.equal(r.code, 0, r.out);
		assert.match(r.stdout, /\(none\)/);
		const j = h.dt('list', 'containers', '--json');
		assert.deepEqual(JSON.parse(j.stdout), []);
	});

	test('list images shows the template with its labels, singular spelling included', () => {
		const r = h.dt('list', 'images');
		assert.equal(r.code, 0, r.out);
		assert.match(r.stdout, /hq\s+ghcr\.io\/dreamteamer\/hq:latest/);
		const s = h.dt('list', 'image', '--json');
		assert.equal(JSON.parse(s.stdout)[0].template, 'hq');
	});

	test('start container <name> --template hq creates from the image, binds loopback:8100, mounts three volumes, injects no token', async () => {
		const r = h.dt('start', 'container', 'hq-dana', '--template', 'hq', '--no-open');
		assert.equal(r.code, 0, r.out);
		assert.match(r.stdout, /✔ created hq-dana from ghcr\.io\/dreamteamer\/hq:latest/);
		assert.match(r.stdout, /http:\/\/localhost:8100\/\?folder=\/workspaces\/hq-dana/);
		const st = await fake.state();
		const create = st.requests.find((q) => q.path.startsWith('/containers/create'));
		assert.ok(create, 'no create request reached Docker');
		assert.equal(create.path, '/containers/create?name=hq-dana');
		assert.equal(create.body.Labels['dreamteamer.workspace'], 'hq-dana');
		assert.equal(create.body.Labels['dreamteamer.template'], 'hq');
		assert.deepEqual(create.body.HostConfig.PortBindings, { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8100' }] });
		assert.deepEqual(create.body.HostConfig.Mounts.map((m) => `${m.Source}:${m.Target}`), ['dreamteamer-hq-dana-workspace:/workspaces/hq-dana', 'dreamteamer-hq-dana-home:/home/node', 'dreamteamer-hq-dana-files:/files']);
		assert.ok(create.body.Env.every((e) => !/CLAUDE|TOKEN|KEY/i.test(e)), `a credential-shaped env reached the container: ${create.body.Env}`);
		assert.ok(create.body.Env.includes('GIT_AUTHOR_NAME=Test Person'));
		assert.ok(create.body.Env.includes('DT_WORKSPACE_DIR=/workspaces/hq-dana'));
		assert.equal(create.body.Labels['dreamteamer.workdir'], '/workspaces/hq-dana');
		const started = st.requests.some((q) => /\/containers\/.+\/start$/.test(q.path));
		assert.ok(started, 'created but never started');
	});

	test('a second start on the same name is idempotent — no second create, same URL', async () => {
		const creates = async () => (await fake.state()).requests.filter((q) => q.path.startsWith('/containers/create')).length;
		const before = await creates();
		const r = h.dt('start', 'container', 'hq-dana', '--no-open');
		assert.equal(r.code, 0, r.out);
		assert.equal(await creates(), before);
		assert.match(r.stdout, /http:\/\/localhost:8100\//);
	});

	test('the second workspace gets the next port, and a STOPPED workspace keeps its port reserved', () => {
		const r = h.dt('start', 'container', 'hq-eli', '--template', 'hq', '--no-open');
		assert.equal(r.code, 0, r.out);
		assert.match(r.stdout, /localhost:8101\//);
		assert.equal(h.dt('stop', 'container', 'hq-dana').code, 0);
		const third = h.dt('start', 'container', 'hq-noa', '--template', 'hq', '--no-open');
		assert.equal(third.code, 0, third.out);
		assert.match(third.stdout, /localhost:8102\//, 'the stopped container\'s 8100 was handed out again');
	});

	test('get container <name> and get containers/<name> both answer with the categorised detail', () => {
		const a = h.dt('get', 'container', 'hq-eli');
		assert.equal(a.code, 0, a.out);
		const d = JSON.parse(a.stdout);
		assert.equal(d.name, 'hq-eli');
		assert.equal(d.port, 8101);
		assert.equal(d.volumes.workspace, 'dreamteamer-hq-eli-workspace');
		const b = h.dt('get', 'containers/hq-eli');
		assert.equal(JSON.parse(b.stdout).editor_url, d.editor_url);
	});

	test('start of an absent container without --template names the flag and exits 1', () => {
		const r = h.dt('start', 'container', 'hq-nobody');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /--template <t>/);
	});

	test('an absent image is pulled before create', async () => {
		const r = h.dt('start', 'container', 'hq-pulled', '--template', 'other', '--no-open');
		assert.equal(r.code, 0, r.out);
		assert.deepEqual((await fake.state()).pulls, ['ghcr.io/dreamteamer/other:latest']);
		assert.match(r.stdout, /pulling ghcr\.io\/dreamteamer\/other:latest/);
	});

	test('DT_IMAGE_<template> pins a template to any image ref', async () => {
		fs.mkdirSync(h.home, { recursive: true });
		fs.appendFileSync(path.join(h.home, '.env'), 'DT_IMAGE_hq=ghcr.io/example/hq:9\n');
		const r = h.dt('start', 'container', 'hq-pinned', '--template', 'hq', '--no-open');
		assert.equal(r.code, 0, r.out);
		const { pulls } = await fake.state();
		assert.ok(pulls.includes('ghcr.io/example/hq:9'), `pulled ${pulls}`);
		fs.writeFileSync(path.join(h.home, '.env'), fs.readFileSync(path.join(h.home, '.env'), 'utf8').replace(/DT_IMAGE_hq=.*\n/, ''));
	});

	test('rm keeps the three volumes; rm --force removes them', async () => {
		const r = h.dt('rm', 'container', 'hq-noa');
		assert.equal(r.code, 0, r.out);
		assert.match(r.stdout, /kept volumes dreamteamer-hq-noa-workspace, dreamteamer-hq-noa-home, dreamteamer-hq-noa-files/);
		assert.deepEqual((await fake.state()).volumesRemoved, []);
		const f = h.dt('rm', 'container', 'hq-eli', '--force');
		assert.equal(f.code, 0, f.out);
		assert.deepEqual((await fake.state()).volumesRemoved, ['dreamteamer-hq-eli-workspace', 'dreamteamer-hq-eli-home', 'dreamteamer-hq-eli-files']);
		assert.equal(h.dt('get', 'container', 'hq-eli').code, 1);
	});

	test('a lifecycle verb aimed at a record collection is refused by name, on a bare host', () => {
		const r = h.dt('start', 'tasks');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /`start` is a container lifecycle verb — "tasks" is not a container/);
		assert.match(r.stderr, /bare `dt start` serves the REST api/);
		const s = h.dt('stop', 'meetings/kickoff');
		assert.equal(s.code, 1);
		assert.match(s.stderr, /lifecycle verb/);
	});

	test('add image --template pulls; rm image removes; start on an image is refused', async () => {
		const a = h.dt('add', 'image', '--template', 'third');
		assert.equal(a.code, 0, a.out);
		assert.ok((await fake.state()).pulls.includes('ghcr.io/dreamteamer/third:latest'));
		assert.equal(h.dt('rm', 'image', 'ghcr.io/dreamteamer/third:latest').code, 0);
		assert.equal(h.dt('get', 'image', 'ghcr.io/dreamteamer/third:latest').code, 1);
		const s = h.dt('start', 'image', HQ);
		assert.equal(s.code, 1);
		assert.match(s.stderr, /an image is started by starting a container from it/);
	});

	test('setup writes the host defaults once, reports Docker, and leaves an existing .env alone', () => {
		const first = h.dt('setup');
		assert.equal(first.code, 0, first.out);
		assert.match(first.stdout, /docker\s+99\.0\.0-fake · api 1\.99/);
		const envFile = path.join(h.home, '.env');
		const text = fs.readFileSync(envFile, 'utf8');
		for (const k of ['DT_PORT_BASE=8100', 'DT_BIND=127.0.0.1', 'DT_REGISTRY=ghcr.io/dreamteamer', 'DT_TEMPLATE_TAG=latest']) assert.ok(text.includes(k), `${k} missing from ${text}`);
		fs.appendFileSync(envFile, 'DT_PORT_BASE=9000\n');
		const second = h.dt('setup');
		assert.equal(second.code, 0, second.out);
		assert.match(second.stdout, /host env .* present/);
		assert.ok(fs.readFileSync(envFile, 'utf8').includes('DT_PORT_BASE=9000'), 'setup rewrote a value the operator had set');
	});

	test('stop leaves the container exited, keeps its volumes, and --json prints the detail', () => {
		const r = h.dt('stop', 'container', 'hq-dana', '--json');
		assert.equal(r.code, 0, r.out);
		assert.match(r.stdout, /✔ stopped hq-dana · volumes kept/);
		const detail = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
		assert.equal(detail.state, 'exited');
		assert.equal(detail.volumes.home, 'dreamteamer-hq-dana-home');
		assert.equal(JSON.parse(h.dt('get', 'container', 'hq-dana').stdout).state, 'exited');
	});

	test('open prints the editor URL (and refuses an absent container)', () => {
		const r = h.dt('open', 'container', 'hq-dana', '--no-open');
		assert.equal(r.code, 0, r.out);
		assert.equal(r.stdout.trim(), 'http://localhost:8100/?folder=/workspaces/hq-dana');
		const attach = h.dt('open', 'container', 'hq-dana', '--vscode', '--no-open');
		assert.equal(attach.code, 0, attach.out);
		assert.equal(attach.stdout.trim(), `vscode-remote://attached-container+${Buffer.from('hq-dana').toString('hex')}/workspaces/hq-dana`);
		const gone = h.dt('open', 'container', 'hq-nobody', '--no-open');
		assert.equal(gone.code, 1);
		assert.match(gone.stderr, /no container "hq-nobody"/);
	});

	test('a container name that is not lowercase-and-safe is refused with the rule', () => {
		const r = h.dt('start', 'container', 'HQ Dana!', '--template', 'hq', '--no-open');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /not a container name — lowercase letters, digits/);
	});

	test('DT_PORT_BASE below 1024 or non-numeric is refused before anything is created', async () => {
		const before = (await fake.state()).requests.filter((q) => q.path.startsWith('/containers/create')).length;
		for (const bad of ['80', 'eighty']) {
			const r = spawnSync(process.execPath, [BIN, 'start', 'container', 'hq-ports', '--template', 'hq', '--no-open'], { cwd: h.dir, env: { ...h.env, DT_PORT_BASE: bad }, encoding: 'utf8' });
			assert.equal(r.status, 1, r.stdout + r.stderr);
			assert.match(r.stderr, /DT_PORT_BASE must be an integer port above 1023/);
		}
		assert.equal((await fake.state()).requests.filter((q) => q.path.startsWith('/containers/create')).length, before);
	});

	test('the process env outranks the host .env: DT_PORT_BASE=9200 lands the container on 9200', () => {
		const r = spawnSync(process.execPath, [BIN, 'start', 'container', 'hq-nine', '--template', 'hq', '--no-open'], { cwd: h.dir, env: { ...h.env, DT_PORT_BASE: '9200' }, encoding: 'utf8' });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /localhost:9200\//);
		assert.equal(h.dt('rm', 'container', 'hq-nine', '--force').code, 0);
	});

	test('a pull the registry refuses fails with the build and the pin as the two ways out', async () => {
		const r = h.dt('start', 'container', 'hq-missing', '--template', 'missing', '--no-open');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /pull ghcr\.io\/dreamteamer\/missing:latest: Docker answered 404/);
		assert.match(r.stderr, /docker build -t ghcr\.io\/dreamteamer\/missing:latest/);
		assert.match(r.stderr, /DT_IMAGE_<template>/);
		assert.ok(!(await fake.state()).requests.some((q) => q.path.includes('name=hq-missing')), 'a container was created from an image that never arrived');
	});

	test('get image <ref> prints the row; a missing ref exits 1; rm image --force passes force to Docker', async () => {
		const g = h.dt('get', 'image', HQ);
		assert.equal(g.code, 0, g.out);
		assert.equal(JSON.parse(g.stdout).template, 'hq');
		const raw = h.dt('get', 'image', HQ, '--json');
		assert.ok(JSON.parse(raw.stdout).Config.Labels['dreamteamer.template']);
		assert.equal(h.dt('get', 'image', 'dreamteamer/nope:latest').code, 1);
		assert.equal(h.dt('add', 'image', '--template', 'forced').code, 0);
		assert.equal(h.dt('rm', 'image', 'ghcr.io/dreamteamer/forced:latest', '--force').code, 0);
		const del = (await fake.state()).requests.find((q) => q.method === 'DELETE' && q.path.includes('forced'));
		assert.match(del.path, /force=true/);
	});

	test('a Docker container that is not a dreamteamer workspace is never touched', () => {
		const r = h.dt('get', 'container', 'plain-nginx');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /not a dreamteamer workspace \(no dreamteamer\.workspace label\)/);
		assert.equal(h.dt('rm', 'container', 'plain-nginx').code, 1);
		assert.equal(h.dt('stop', 'container', 'plain-nginx').code, 1);
		const list = JSON.parse(h.dt('list', 'containers', '--json').stdout);
		assert.ok(!list.some((c) => c.name === 'plain-nginx'), 'list showed a container without the workspace label');
	});

	test('help documents every container verb and flag the dispatch accepts', () => {
		const help = h.dt('help').stdout;
		for (const line of [/^ {2}setup {7}/m, /^ {2}start {7}container <name> --template <t>/m, /^ {2}stop {8}container <name>/m, /^ {2}open {8}container <name>/m, /--no-open/, /--force/, /DT_IMAGE_<template>/]) assert.match(help, line);
	});

	test('--mount adds bind and volume mounts beside the three; a mount aimed at an own volume is refused', async () => {
		const r = h.dt('start', 'container', 'hq-mounts', '--template', 'hq', '--no-open', '--mount', `${h.dir}:/mnt/shared:ro`, '--mount', 'team-files:/files-team');
		assert.equal(r.code, 0, r.out);
		const create = (await fake.state()).requests.find((q) => q.path === '/containers/create?name=hq-mounts');
		const extra = create.body.HostConfig.Mounts.slice(3);
		assert.deepEqual(extra, [{ Type: 'bind', Source: h.dir, Target: '/mnt/shared', ReadOnly: true }, { Type: 'volume', Source: 'team-files', Target: '/files-team', ReadOnly: false }]);
		assert.match(r.stdout, /mounts .*→\/mnt\/shared \(ro\), team-files→\/files-team/);
		const d = JSON.parse(h.dt('get', 'container', 'hq-mounts').stdout);
		assert.deepEqual(d.mounts, [`${h.dir}:/mnt/shared:ro`, 'team-files:/files-team']);
		assert.equal(d.workspace_dir, '/workspaces/hq-mounts');
		const bad = h.dt('start', 'container', 'hq-bad', '--template', 'hq', '--no-open', '--mount', 'x:/home/node');
		assert.equal(bad.code, 1);
		assert.match(bad.stderr, /--mount cannot target \/home\/node/);
		const shape = h.dt('start', 'container', 'hq-bad', '--template', 'hq', '--no-open', '--mount', 'nocolon');
		assert.equal(shape.code, 1);
		assert.match(shape.stderr, /--mount takes <host-path\|volume>:<container-path>\[:ro\]/);
	});

	test('--repo hands the clone URL to the container as DT_REPO, and refuses a word that is not a URL', async () => {
		const r = h.dt('start', 'container', 'hq-joined', '--template', 'hq', '--no-open', '--repo', 'https://github.com/example/hq-joined.git');
		assert.equal(r.code, 0, r.out);
		const create = (await fake.state()).requests.find((q) => q.path === '/containers/create?name=hq-joined');
		assert.ok(create.body.Env.includes('DT_REPO=https://github.com/example/hq-joined.git'));
		assert.match(r.stdout, /clones https:\/\/github\.com\/example\/hq-joined\.git on first start/);
		assert.equal(JSON.parse(h.dt('get', 'container', 'hq-joined').stdout).repo, 'https://github.com/example/hq-joined.git');
		const bad = h.dt('start', 'container', 'hq-bad2', '--template', 'hq', '--no-open', '--repo', 'not-a-url');
		assert.equal(bad.code, 1);
		assert.match(bad.stderr, /--repo takes a git URL or an absolute path/);
	});

	test('setup --json refuses an unknown flag like every other verb', () => {
		const r = h.dt('setup', '--templte', 'hq');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /unknown flag "--templte" on `dt setup`/);
	});
});

describe('when Docker is not there', () => {
	test('every driver verb names the socket and the fix, at exit 1', () => {
		const h = harness();
		try {
			const r = h.dt('list', 'containers');
			assert.equal(r.code, 1);
			assert.match(r.stderr, /Docker is not reachable at .*d\.sock/);
			assert.match(r.stderr, /dt setup/);
			const s = h.dt('setup');
			assert.equal(s.code, 1);
			assert.match(s.stdout + s.stderr, /docker\s+✖/);
		} finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
	});
});

describe('inside a workspace the same verbs answer, and record collections stay records', () => {
	test('dt start tasks inside a workspace is the same refusal, not a server', async () => {
		const ws = twoModuleWorkspace();
		const r = ws.dt('start', 'tasks');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /container lifecycle verb/);
	});

	test('dt list containers inside a workspace goes to Docker, not to data/', async () => {
		const h = harness();
		const fake = await startFakeDocker(h.sock, { images: h.images });
		try {
			const ws = twoModuleWorkspace();
			const r = spawnSync(process.execPath, [BIN, 'list', 'containers', '--json'], { cwd: ws.root, env: h.env, encoding: 'utf8' });
			assert.equal(r.status, 0, r.stderr);
			assert.deepEqual(JSON.parse(r.stdout), []);
			const i = spawnSync(process.execPath, [BIN, 'list', 'images', '--json'], { cwd: ws.root, env: h.env, encoding: 'utf8' });
			assert.equal(JSON.parse(i.stdout)[0].template, 'hq');
			assert.ok(!fs.existsSync(path.join(ws.root, 'data', 'containers')), 'a driver collection grew a data/ folder');
		} finally { await fake.close(); fs.rmSync(h.dir, { recursive: true, force: true }); }
	});
});

describe('the no-dependency promise', () => {
	test('the driver imports node: modules and engine files only, and package.json gained no dependency', () => {
		const src = fs.readFileSync(path.join(ENGINE_ROOT, 'src', 'containers.js'), 'utf8');
		const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
		assert.ok(imports.length > 0);
		for (const i of imports) assert.ok(i.startsWith('node:') || i.startsWith('./'), `containers.js imports ${i}`);
		const pkg = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8'));
		assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['ajv', 'ajv-formats', 'express', 'fractional-indexing', 'js-yaml', 'yaml']);
		assert.equal(pkg.bin.dt, 'bin/dreamteamer.js', 'the `dt` bin the four-line install promises');
	});
});

describe('the REST route dispatches driver collections to Docker', () => {
	test('GET list/get answer from the fake; every write is 405 with the CLI spelling; the descriptors are compiled with storage.driver', async () => {
		const h = harness();
		// ⚠ EVERYTHING that can keep the process alive — the fake's child, the server — is created INSIDE
		// the try, so an assertion that fails early still reaches the finally that shuts them down. The
		// first version created them before the try, and one TypeError left the runner waiting forever.
		let fake; let server;
		const prevSock = process.env.DT_DOCKER_SOCKET;
		const log = console.log;
		try {
			fake = await startFakeDocker(h.sock, { images: h.images });
			const ws = twoModuleWorkspace();
			const containersYaml = fs.readFileSync(path.join(ws.root, '.dreamteamer', 'collections', 'containers.collection.yaml'), 'utf8');
			assert.match(containersYaml, /^storage:\n(?:.*\n)*?\s+driver: docker/m);
			assert.match(containersYaml, /^group: system$/m);
			assert.match(fs.readFileSync(path.join(ws.root, '.dreamteamer', 'collections', 'images.collection.yaml'), 'utf8'), /driver: docker/);
			// check and commit read zero records from a driver collection and say nothing about them
			const check = ws.dt('check');
			assert.equal(check.code, 0, check.stderr);
			assert.doesNotMatch(check.stdout + check.stderr, /containers|images/);
			process.env.DT_DOCKER_SOCKET = h.sock;
			const { startServer } = await import('../../src/server.js');
			const PORT = 8171;
			console.log = () => {};
			// the server takes the workspace shape findWorkspace returns — root AND its package.json
			server = await startServer({ root: ws.root, pkg: JSON.parse(fs.readFileSync(path.join(ws.root, 'package.json'), 'utf8')) }, { port: PORT });
			console.log = log;
			const base = `http://127.0.0.1:${PORT}/api`;
			const list = await (await fetch(`${base}/collections/images/records`)).json();
			assert.equal(list.total, 1);
			assert.equal(list.records[0].template, 'hq');
			assert.equal(list.records[0].id, HQ);
			const none = await (await fetch(`${base}/collections/containers/records`)).json();
			assert.deepEqual(none, { records: [], total: 0 });
			assert.equal(spawnSync(process.execPath, [BIN, 'start', 'container', 'hq-rest', '--template', 'hq', '--no-open'], { cwd: ws.root, env: h.env, encoding: 'utf8' }).status, 0);
			const one = await (await fetch(`${base}/collections/containers/records/hq-rest`)).json();
			assert.equal(one.fields.name, 'hq-rest');
			assert.equal(one.fields.workspace_dir, '/workspaces/hq-rest');
			const missing = await fetch(`${base}/collections/containers/records/nobody`);
			assert.equal(missing.status, 404);
			const write = await fetch(`${base}/collections/containers/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
			assert.equal(write.status, 405);
			assert.match((await write.json()).error, /dt start container <name> --template <t>/);
			// and an ordinary collection still answers from the store
			const tasks = await (await fetch(`${base}/collections/tasks/records`)).json();
			assert.equal(tasks.total, 0);
		} finally {
			console.log = log;
			// fetch keeps its connections alive; close() waits for them forever unless they are cut first
			if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
			if (prevSock === undefined) delete process.env.DT_DOCKER_SOCKET; else process.env.DT_DOCKER_SOCKET = prevSock;
			if (fake) await fake.close();
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});
