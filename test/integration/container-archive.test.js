// `dt export container` / `dt import container`, driven through the real CLI against the fake Engine
// API — whose container files are a real folder and whose …/archive routes are the system `tar`, so
// the round trip is checked against a real tar on both ends. Every test asserts what reached the
// container (or did NOT), not that a code path ran.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ENGINE_ROOT } from '../helpers/ws.js';

const BIN = path.join(ENGINE_ROOT, 'bin', 'dreamteamer.js');
const FAKE = path.join(ENGINE_ROOT, 'test', 'helpers', 'fake-docker.js');
const HQ = 'ghcr.io/dreamteamer/hq:latest';
const PASS = 'correct horse battery staple';

function startFake(sock, fsRoot) {
	return new Promise((resolve, reject) => {
		const images = [{ ref: HQ, labels: { 'dreamteamer.template': 'hq', 'dreamteamer.ports': '8080' } }];
		const child = spawn(process.execPath, [FAKE, sock, JSON.stringify(images), '[]'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, FAKE_DOCKER_FS: fsRoot } });
		child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(handle); });
		child.on('exit', (code) => reject(new Error(`fake docker exited ${code}`)));
		const state = () => new Promise((ok, no) => {
			const req = http.get({ socketPath: sock, path: '/_fake/state' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok(JSON.parse(b))); });
			req.on('error', no);
		});
		const handle = { state, close: () => new Promise((ok) => { child.once('exit', () => ok()); child.kill(); }) };
	});
}

/** A .tar.gz with exactly these entries — how a hostile export is made, since no honest tool writes one. */
function tarGz(entries) {
	const blocks = [];
	for (const e of entries) {
		const h = Buffer.alloc(512); const data = Buffer.from(e.data ?? '');
		h.write(e.name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
		h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
		h.write(e.type ?? '0', 156); h.write(e.linkname ?? '', 157); h.write('ustar\u000000', 257, 'latin1');
		h.fill(32, 148, 156); let sum = 0; for (const b of h) sum += b; h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
		blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	return zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const listTarGz = (file) => spawnSync('tar', ['-tzf', file], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

describe('export and import a container\'s workspaces', () => {
	let dir, sock, fsRoot, bare, fake, env;
	const dt = (...args) => {
		const extra = typeof args[args.length - 1] === 'object' ? args.pop() : {};
		const r = spawnSync(process.execPath, [BIN, ...args], { cwd: bare, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
		return { code: r.status, stdout: r.stdout, out: r.stdout + r.stderr + (r.error ? `\n[spawn] ${r.error.message}` : '') };
	};
	const at = (container, p) => path.join(fsRoot, container, p);
	const put = (container, p, data) => { fs.mkdirSync(path.dirname(at(container, p)), { recursive: true }); fs.writeFileSync(at(container, p), data); };
	const out = (n) => path.join(dir, n);
	/** Requests made after `since` — how "nothing was written" is asserted: no PUT, no chown. */
	const writesSince = async (since) => {
		const s = await fake.state();
		return { puts: s.requests.slice(since).filter((r) => r.method === 'PUT'), chowns: s.execs.filter((e) => e.Cmd[0] === 'chown') };
	};
	const mark = async () => (await fake.state()).requests.length;

	before(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-arch-'));
		sock = path.join(dir, 'd.sock'); fsRoot = path.join(dir, 'fs'); bare = path.join(dir, 'bare');
		fs.mkdirSync(bare, { recursive: true }); fs.mkdirSync(fsRoot);
		const { DT_EXPORT_PASSPHRASE, ...rest } = process.env; // the suite's own env must not supply one
		env = { ...rest, DT_DOCKER_SOCKET: sock, DT_HOME: path.join(dir, 'home'), DT_HEALTH_TIMEOUT: '0', DT_PERSON_NAME: 'Test Person', DT_PERSON_EMAIL: 'test@example.invalid' };
		fake = await startFake(sock, fsRoot);
		for (const name of ['hq-dana', 'hq-eli']) assert.equal(dt('start', 'container', name, '--template', 'hq', '--no-open').code, 0);
	});
	after(async () => { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
	beforeEach(() => {
		fs.rmSync(path.join(fsRoot, 'hq-dana'), { recursive: true, force: true });
		put('hq-dana', 'workspaces/hq-dana/README.md', '# acme\n');
		put('hq-dana', 'workspaces/hq-dana/notes/2026-09-01--kickoff.md', 'dana met acme\n');
		put('hq-dana', 'workspaces/hq-dana/node_modules/pkg/index.js', 'module.exports = 1\n');
		put('hq-dana', 'workspaces/.files/hq-dana/recording.m4a', 'audio');
		put('hq-dana', 'home/node/.claude/.credentials.json', '{"token":"login-secret"}');
		fs.symlinkSync('README.md', at('hq-dana', 'workspaces/hq-dana/readme-link'));
		for (const f of fs.readdirSync(dir)) if (/\.(dtx|tgz|partial)$/.test(f)) fs.rmSync(out(f));
	});

	test('an encrypted export round-trips into an emptied workspace: files, a symlink, owned by node — and never node_modules, .files or the home', async () => {
		const e = dt('export', 'container', 'hq-dana', '--out', out('a.dtx'), { DT_EXPORT_PASSPHRASE: PASS });
		assert.equal(e.code, 0, e.out);
		assert.match(e.stdout, /hq-dana {2}2 files/);
		assert.match(e.stdout, /left behind: .*hq-dana\/node_modules/);
		assert.match(e.stdout, /left behind: .*\.files/);
		assert.match(e.stdout, /encrypted with the owner passphrase/);
		const bytes = fs.readFileSync(out('a.dtx'));
		assert.equal(bytes.subarray(0, 8).toString(), 'DTEXPORT');
		assert.ok(!bytes.includes('dana met acme') && !bytes.includes(PASS), 'plaintext or the passphrase is in the file');
		const s = await fake.state();
		const reads = s.requests.filter((r) => r.path.includes('/archive'));
		assert.ok(reads.length && reads.every((r) => r.method === 'GET' && r.path.endsWith('?path=%2Fworkspaces')), JSON.stringify(reads));
		// the fresh volume a new container would get
		fs.rmSync(at('hq-dana', 'workspaces/hq-dana'), { recursive: true }); fs.mkdirSync(at('hq-dana', 'workspaces/hq-dana'));
		const i = dt('import', 'container', 'hq-dana', out('a.dtx'), { DT_EXPORT_PASSPHRASE: PASS });
		assert.equal(i.code, 0, i.out);
		assert.equal(fs.readFileSync(at('hq-dana', 'workspaces/hq-dana/notes/2026-09-01--kickoff.md'), 'utf8'), 'dana met acme\n');
		assert.equal(fs.readlinkSync(at('hq-dana', 'workspaces/hq-dana/readme-link')), 'README.md');
		assert.ok(!fs.existsSync(at('hq-dana', 'workspaces/hq-dana/node_modules')));
		const chown = (await fake.state()).execs.filter((x) => x.Cmd[0] === 'chown').pop();
		assert.deepEqual({ Cmd: chown.Cmd, User: chown.User }, { Cmd: ['chown', '-R', 'node:node', '/workspaces/hq-dana'], User: 'root' });
	});

	test('--no-encrypt writes a plain .tar.gz rooted at the workspace folders, and says so', () => {
		fs.writeFileSync(at('hq-dana', 'workspaces/stray.txt'), 'not a workspace');
		const e = dt('export', 'container', 'hq-dana', '--out', out('p.tgz'), '--no-encrypt');
		assert.equal(e.code, 0, e.out);
		assert.match(e.stdout, /NOT encrypted/);
		const names = listTarGz(out('p.tgz'));
		assert.ok(names.includes('hq-dana/README.md'), names.join('\n'));
		assert.deepEqual(names.filter((n) => !n.startsWith('hq-dana/')), []);
		assert.deepEqual(names.filter((n) => /node_modules|\.files|home|credentials/.test(n)), []);
	});

	test('a stopped container exports; importing into it is refused, naming dt start', () => {
		assert.equal(dt('stop', 'container', 'hq-dana').code, 0);
		const e = dt('export', 'container', 'hq-dana', '--out', out('s.tgz'), '--no-encrypt');
		assert.equal(e.code, 0, e.out);
		const i = dt('import', 'container', 'hq-dana', out('s.tgz'), '--replace');
		assert.equal(i.code, 1);
		assert.match(i.out, /exited — import needs it running: dt start container hq-dana/);
		assert.equal(dt('start', 'container', 'hq-dana', '--no-open').code, 0);
	});

	test('the passphrase is never an argument: --passphrase is refused, and with no env and no terminal nothing is written', () => {
		const a = dt('export', 'container', 'hq-dana', '--out', out('x.dtx'), '--passphrase', PASS);
		assert.equal(a.code, 1);
		assert.match(a.out, /never a flag/);
		const b = dt('export', 'container', 'hq-dana', '--out', out('x.dtx'));
		assert.equal(b.code, 1);
		assert.match(b.out, /DT_EXPORT_PASSPHRASE/);
		assert.ok(!fs.existsSync(out('x.dtx')) && !fs.existsSync(out('x.dtx.partial')));
		assert.equal(dt('import', 'container', 'hq-dana', out('x.dtx'), '--passphrase', PASS).code, 1);
	});

	test('a wrong passphrase is told apart from damage, and writes nothing', async () => {
		assert.equal(dt('export', 'container', 'hq-dana', '--out', out('w.dtx'), { DT_EXPORT_PASSPHRASE: PASS }).code, 0);
		const since = await mark();
		const r = dt('import', 'container', 'hq-dana', out('w.dtx'), '--replace', { DT_EXPORT_PASSPHRASE: 'not the passphrase' });
		assert.equal(r.code, 1);
		assert.match(r.out, /wrong passphrase .* nothing was written/);
		const w = await writesSince(since);
		assert.equal(w.puts.length, 0);
		assert.equal(fs.readFileSync(at('hq-dana', 'workspaces/hq-dana/README.md'), 'utf8'), '# acme\n');
	});

	test('a flipped byte, a truncated file and an appended chunk each fail authentication before anything is written', async () => {
		// enough data for several 64 KiB chunks, so the damage lands in the MIDDLE
		put('hq-dana', 'workspaces/hq-dana/big.bin', crypto.randomBytes(300_000));
		assert.equal(dt('export', 'container', 'hq-dana', '--out', out('t.dtx'), { DT_EXPORT_PASSPHRASE: PASS }).code, 0);
		const good = fs.readFileSync(out('t.dtx'));
		assert.ok(good.length > 3 * 65536, `only ${good.length} bytes`);
		const flipped = Buffer.from(good); flipped[100_000] ^= 1;
		// 72 header bytes, then chunks of 64 KiB + a 16-byte tag; the last is shorter and marked final.
		// Dropping exactly that last chunk leaves a file of whole, individually VALID chunks — only the
		// final mark tells it from a complete one.
		const boundary = good.subarray(0, 72 + Math.floor((good.length - 72 - 1) / 65552) * 65552);
		const cases = { flipped, 'cut mid-chunk': good.subarray(0, good.length - 100), 'cut at a chunk boundary': boundary, appended: Buffer.concat([good, good.subarray(72, 72 + 65552)]) };
		for (const [what, bytes] of Object.entries(cases)) {
			fs.writeFileSync(out('bad.dtx'), bytes);
			const since = await mark();
			const r = dt('import', 'container', 'hq-dana', out('bad.dtx'), '--replace', { DT_EXPORT_PASSPHRASE: PASS });
			assert.equal(r.code, 1, `${what}: ${r.out}`);
			assert.match(r.out, /the export is (damaged or truncated|truncated)/, what);
			assert.equal((await writesSince(since)).puts.length, 0, `${what} reached the container`);
		}
		assert.ok(fs.existsSync(at('hq-dana', 'workspaces/hq-dana/README.md')), 'a refused import emptied the workspace');
	});

	test('a workspace that already holds files is refused without --replace; --replace empties it first', () => {
		assert.equal(dt('export', 'container', 'hq-dana', '--out', out('r.tgz'), '--no-encrypt').code, 0);
		put('hq-dana', 'workspaces/hq-dana/stale.md', 'from before');
		const a = dt('import', 'container', 'hq-dana', out('r.tgz'));
		assert.equal(a.code, 1);
		assert.match(a.out, /\/workspaces\/hq-dana already holds files .* --replace/);
		assert.ok(fs.existsSync(at('hq-dana', 'workspaces/hq-dana/stale.md')));
		const b = dt('import', 'container', 'hq-dana', out('r.tgz'), '--replace');
		assert.equal(b.code, 0, b.out);
		assert.ok(!fs.existsSync(at('hq-dana', 'workspaces/hq-dana/stale.md')), '--replace left a stale file');
		assert.ok(fs.existsSync(at('hq-dana', 'workspaces/hq-dana/README.md')));
	});

	test('an entry that escapes — absolute, .., a symlink out of its workspace, a hard link, a loose file — is refused and nothing is written', async () => {
		const hostile = {
			absolute: [{ name: '/etc/cron.d/x', data: 'x' }],
			dotdot: [{ name: 'hq-dana/', type: '5' }, { name: 'hq-dana/../../etc/x', data: 'x' }],
			'symlink out': [{ name: 'hq-dana/', type: '5' }, { name: 'hq-dana/l', type: '2', linkname: '../../etc/passwd' }],
			'symlink to another workspace': [{ name: 'hq-dana/', type: '5' }, { name: 'hq-dana/l', type: '2', linkname: '../hq-eli' }],
			'absolute symlink': [{ name: 'hq-dana/', type: '5' }, { name: 'hq-dana/l', type: '2', linkname: '/home/node/.claude' }],
			'hard link': [{ name: 'hq-dana/', type: '5' }, { name: 'hq-dana/h', type: '1', linkname: 'hq-dana/README.md' }],
			'loose file': [{ name: 'loose.txt', data: 'x' }],
		};
		for (const [what, entries] of Object.entries(hostile)) {
			fs.writeFileSync(out('h.tgz'), tarGz(entries));
			const since = await mark();
			const r = dt('import', 'container', 'hq-dana', out('h.tgz'), '--replace');
			assert.equal(r.code, 1, `${what}: ${r.out}`);
			assert.match(r.out, /nothing was written/, what);
			assert.equal((await writesSince(since)).puts.length, 0, `${what} reached the container`);
		}
		assert.ok(fs.existsSync(at('hq-dana', 'workspaces/hq-dana/README.md')));
	});

	test('a workspace that would land on the container\'s own layer is refused — it would vanish with the container', async () => {
		assert.equal(dt('export', 'container', 'hq-dana', '--out', out('o.tgz'), '--no-encrypt').code, 0);
		fs.mkdirSync(at('hq-eli', 'workspaces'), { recursive: true });
		const since = await mark();
		const r = dt('import', 'container', 'hq-eli', out('o.tgz'));
		assert.equal(r.code, 1);
		assert.match(r.out, /\/workspaces\/hq-dana would land on overlay, not a volume/);
		assert.equal((await writesSince(since)).puts.length, 0);
	});

	test('--workspace narrows both ends: export reads only that folder, import writes only that one', async () => {
		put('hq-dana', 'workspaces/beta/x.md', 'beta');
		const since = await mark();
		assert.equal(dt('export', 'container', 'hq-dana', '--workspace', 'hq-dana', '--out', out('n.tgz'), '--no-encrypt').code, 0);
		const reads = (await fake.state()).requests.slice(since).filter((r) => r.path.includes('/archive'));
		assert.deepEqual(reads.map((r) => r.path.split('?')[1]), ['path=%2Fworkspaces%2Fhq-dana']);
		assert.ok(listTarGz(out('n.tgz')).every((n) => n.startsWith('hq-dana/')));
		// both workspaces in one file; import only one of them
		assert.equal(dt('export', 'container', 'hq-dana', '--out', out('both.tgz'), '--no-encrypt').code, 0);
		fs.rmSync(at('hq-dana', 'workspaces/beta'), { recursive: true });
		const r = dt('import', 'container', 'hq-dana', out('both.tgz'), '--workspace', 'hq-dana', '--replace');
		assert.equal(r.code, 0, r.out);
		assert.ok(!fs.existsSync(at('hq-dana', 'workspaces/beta')), '--workspace imported a workspace it did not name');
		const miss = dt('import', 'container', 'hq-dana', out('both.tgz'), '--workspace', 'gamma');
		assert.match(miss.out, /holds no workspace gamma/);
	});

	test('an unknown flag is refused, not swallowed', () => {
		const r = dt('export', 'container', 'hq-dana', '--out', out('u.tgz'), '--no-encrpyt');
		assert.equal(r.code, 1);
		assert.match(r.out, /unknown flag "--no-encrpyt"/);
		assert.ok(!fs.existsSync(out('u.tgz')));
	});
});
