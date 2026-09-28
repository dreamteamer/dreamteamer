// container-archive.js — `dt export container` and `dt import container`: a machine's WORKSPACES out
// of one container and into another, as one file. The move primitive between two laptops (and, when
// the other side implements docs/container-export-format.md, between a laptop and a hosted machine).
//
// WHAT TRAVELS. The trees under /workspaces, one folder per workspace — never the home, so never a
// login: there is no flag that adds it. `node_modules` and `.files` folders stay behind at any depth
// (a reinstall and a files folder are both per-machine). Hard links, devices and fifos are skipped on
// the way out and REFUSED on the way in, with setuid bits and owners dropped both ways: this file
// writes every tar header itself rather than passing Docker's through.
//
// WHY THE TAR IS PARSED HERE. The Engine API speaks tar both ways (GET/PUT …/archive) and cannot
// filter, re-root or check it. Node has gzip and AES-GCM but no tar, and the subset needed — ustar
// headers, PAX and GNU long names in, ustar plus PAX out — is ~60 lines, against a dependency.
//
// ENCRYPTED BY DEFAULT, under the owner's passphrase: scrypt (N=2^17) → AES-256-GCM over 64 KiB
// chunks, each with its own nonce and tag and the LAST one marked, so a flipped byte, a dropped chunk
// and a truncated file all fail authentication. The header carries an HMAC under the derived key, so
// a wrong passphrase is told apart from damage before a single byte is decrypted. The passphrase comes
// from DT_EXPORT_PASSPHRASE (the process env only, never ~/.dreamteamer/.env) or a no-echo prompt —
// never a flag, because every local user's `ps` reads argv.
//
// IMPORT WRITES NOTHING until the whole file has been read once: pass 1 authenticates every chunk and
// checks every entry (no absolute path, no `..`, no symlink leaving its workspace, no link or device),
// pass 2 uploads. Then `chown -R node:node` on the imported folders, as root, by exec.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { api, ok, inspectContainer, exec, parseFlags } from './containers.js';

const ROOT = '/workspaces';
const WS_NAME = /^[a-z0-9][a-z0-9_.-]*$/;
const LEFT_BEHIND = new Set(['node_modules', '.files']);
const FILE = '0', DIR = '5', SYMLINK = '2';
const FLAGS = { export: ['workspace', 'out', 'no-encrypt'], import: ['workspace', 'replace'] };

// ---- tar: read any of ustar · PAX · GNU long names, write ustar (+ PAX when a name is long) -------
const str = (b, o, n) => { const e = b.indexOf(0, o); return b.toString('utf8', o, e === -1 || e > o + n ? o + n : e); };
const num = (b, o, n) => (b[o] & 0x80 ? b.readUIntBE(o + n - 6, 6) : parseInt(str(b, o, n).trim() || '0', 8)); // base-256 above 8 GiB
const sum = (h) => { let s = 0; for (let i = 0; i < 512; i++) s += i >= 148 && i < 156 ? 32 : h[i]; return s; };
const pad = (n) => (512 - (n % 512)) % 512;
export const TAR_END = Buffer.alloc(1024);

function header({ name, type, mode, size, mtime, linkname = '' }) {
	const h = Buffer.alloc(512);
	const oct = (v, o, n) => h.write(`${Math.floor(v).toString(8).padStart(n - 1, '0')}\0`, o, n, 'latin1');
	h.write(name, 0, 100); oct(mode, 100, 8); oct(0, 108, 8); oct(0, 116, 8);
	if (size < 8 ** 11) oct(size, 124, 12); else { h[124] = 0x80; h.writeUIntBE(size, 130, 6); }
	oct(mtime, 136, 12); h.write(type, 156, 1, 'latin1'); h.write(linkname, 157, 100); h.write('ustar\u000000', 257, 8, 'latin1');
	oct(sum(h), 148, 7); h[155] = 32;
	if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(linkname) <= 100) return h;
	// a PAX record's length counts its own digits
	const rec = (k, v) => { const body = ` ${k}=${v}\n`; const n = Buffer.byteLength(body); return `${n + String(n + String(n).length).length}${body}`; };
	const pax = Buffer.from(rec('path', name) + (linkname ? rec('linkpath', linkname) : ''));
	return Buffer.concat([header({ name: 'PaxHeader', type: 'x', mode: 0o644, size: pax.length, mtime }), pax, Buffer.alloc(pad(pax.length)), h]);
}

/** Re-emit a tar: `decide(entry)` answers the name to write it under, or null to drop it. Headers are
 *  rewritten (owner 0, permission bits only); bodies stream through. No end marker — the caller adds one. */
export async function* retar(source, decide) {
	const it = source[Symbol.asyncIterator]();
	let buf = Buffer.alloc(0);
	const fill = async (n) => { while (buf.length < n) { const r = await it.next(); if (r.done) return false; buf = buf.length ? Buffer.concat([buf, r.value]) : r.value; } return true; };
	const take = async (n) => { if (!(await fill(n))) throw new Error('the archive ends in the middle of an entry'); const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
	let ext = {};
	for (;;) {
		if (!(await fill(512))) throw new Error('the archive ends without its end marker');
		const h = await take(512);
		if (h.every((b) => b === 0)) return;
		if (num(h, 148, 8) !== sum(h)) throw new Error('an archive header fails its checksum');
		const type = h[156] ? String.fromCharCode(h[156]) : FILE;
		let size = num(h, 124, 12);
		if ('xgLK'.includes(type)) {
			if (size > 1 << 20) throw new Error('an archive extension header is over 1 MiB');
			const body = (await take(size + pad(size))).subarray(0, size);
			if (type === 'L') ext.path = str(body, 0, size);
			else if (type === 'K') ext.linkpath = str(body, 0, size);
			else if (type === 'x') for (const m of body.toString('utf8').matchAll(/\d+ ([^=]+)=([^\n]*)\n/g)) ext[m[1]] = m[2];
			continue;
		}
		const prefix = str(h, 345, 155);
		const e = { name: ext.path ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100)), linkname: ext.linkpath ?? str(h, 157, 100), type: type === '7' ? FILE : type, mode: num(h, 100, 8) & 0o777, mtime: num(h, 136, 12) };
		size = ext.size !== undefined ? Number(ext.size) : size;
		e.size = e.type === FILE ? size : 0;
		ext = {};
		const name = decide(e);
		if (name) yield header({ ...e, name });
		const keep = name && e.type === FILE; // only a file's body is written; any other entry's is read past
		for (let left = size + pad(size); left > 0;) {
			if (!(await fill(1))) throw new Error('the archive ends in the middle of a file');
			const b = buf.subarray(0, Math.min(left, buf.length)); buf = buf.subarray(b.length); left -= b.length;
			if (keep) yield b;
		}
	}
}

// ---- the sealed format (docs/container-export-format.md) ---------------------------------------
const MAGIC = Buffer.from('DTEXPORT');
const HEAD = 40, MAC = 32, CHUNK = 64 * 1024;

function scryptKeys(pass, salt, log2N, r, p) {
	return new Promise((resolve, reject) => crypto.scrypt(pass.normalize('NFC'), salt, 64, { N: 2 ** log2N, r, p, maxmem: 256 * 2 ** log2N * r * p }, (e, k) => (e ? reject(e) : resolve({ enc: k.subarray(0, 32), mac: k.subarray(32) }))));
}
const hmac = (key, b) => crypto.createHmac('sha256', key).update(b).digest();
const nonce = (prefix, i, last) => { const n = Buffer.alloc(12); prefix.copy(n); n.writeUInt32BE(i, 7); n[11] = last ? 1 : 0; return n; };

async function newSeal(pass) {
	const h = Buffer.alloc(HEAD);
	MAGIC.copy(h); h[8] = 1; h[9] = 17; h[10] = 8; h[11] = 1; h.writeUInt32BE(CHUNK, 12);
	crypto.randomFillSync(h, 16, 23); // salt 16..31 · nonce prefix 32..38 · 39 reserved
	const keys = await scryptKeys(pass, h.subarray(16, 32), 17, 8, 1);
	return { keys, head: Buffer.concat([h, hmac(keys.mac, h)]) };
}

/** Parse and authenticate a header — a wrong passphrase fails HERE, before any chunk is opened. */
async function openSeal(file, pass) {
	const fd = fs.openSync(file, 'r');
	const h = Buffer.alloc(HEAD + MAC);
	const n = fs.readSync(fd, h, 0, h.length, 0); fs.closeSync(fd);
	if (n < h.length) throw new Error(`${file} is too short to be an encrypted export`);
	if (h[8] !== 1) throw new Error(`${file} is export format version ${h[8]} — this engine reads version 1; upgrade dreamteamer`);
	const [log2N, r, p, chunk] = [h[9], h[10], h[11], h.readUInt32BE(12)];
	if (log2N < 14 || log2N > 20 || r < 1 || r > 16 || p < 1 || p > 4 || chunk < 1024 || chunk > 1 << 24) throw new Error(`${file}: its header asks for parameters outside what an export uses — refusing it`);
	const keys = await scryptKeys(pass, h.subarray(16, 32), log2N, r, p);
	if (!crypto.timingSafeEqual(hmac(keys.mac, h.subarray(0, HEAD)), h.subarray(HEAD))) throw new Error(`wrong passphrase for ${file} (or its header is damaged) — nothing was written`);
	return { keys, prefix: h.subarray(32, 39), chunk };
}

async function* seal(src, { keys, head }) {
	const prefix = head.subarray(32, 39);
	const box = (pt, i, last) => { const c = crypto.createCipheriv('aes-256-gcm', keys.enc, nonce(prefix, i, last)); return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]); };
	yield head;
	let buf = Buffer.alloc(0), i = 0;
	for await (const b of src) { buf = Buffer.concat([buf, b]); while (buf.length > CHUNK) { yield box(buf.subarray(0, CHUNK), i++, false); buf = buf.subarray(CHUNK); } }
	yield box(buf, i, true); // a final chunk always exists, empty or not — its flag is what makes truncation visible
}

async function* unseal(src, { keys, prefix, chunk }) {
	const open = (b, i, last) => {
		const d = crypto.createDecipheriv('aes-256-gcm', keys.enc, nonce(prefix, i, last));
		d.setAuthTag(b.subarray(b.length - 16));
		try { return Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]); } catch { throw new Error(`the export is damaged or truncated (chunk ${i} fails authentication) — nothing was written`); }
	};
	let buf = Buffer.alloc(0), i = 0;
	for await (const b of src) { buf = Buffer.concat([buf, b]); while (buf.length > chunk + 16) { yield open(buf.subarray(0, chunk + 16), i++, false); buf = buf.subarray(chunk + 16); } }
	if (buf.length < 16) throw new Error('the export is truncated (its last chunk is missing) — nothing was written');
	yield open(buf, i, true);
}

// ---- the passphrase: env or a no-echo prompt, never argv -----------------------------------------
async function passphrase({ confirm }) {
	let v = process.env.DT_EXPORT_PASSPHRASE;
	if (v === undefined) {
		if (!process.stdin.isTTY) throw new Error('an encrypted export needs the owner passphrase — set DT_EXPORT_PASSPHRASE, or run in a terminal to be asked (it is never a flag); --no-encrypt writes a plain .tar.gz');
		v = await ask('passphrase: ');
		if (confirm && (await ask('again: ')) !== v) throw new Error('the two passphrases differ — nothing was written');
	}
	if (confirm && v.length < 8) throw new Error('the passphrase must be at least 8 characters');
	if (!v) throw new Error('the passphrase is empty');
	return v;
}

function ask(prompt) {
	return new Promise((resolve, reject) => {
		const s = process.stdin; let v = '';
		const done = (f) => { s.off('data', on); s.setRawMode(false); s.pause(); process.stderr.write('\n'); f(); };
		const on = (d) => {
			for (const ch of d) {
				if (ch === '\r' || ch === '\n') return done(() => resolve(v));
				if (ch === '\u0003' || ch === '\u0004') return done(() => reject(new Error('cancelled — nothing was written')));
				v = ch === '\u007f' || ch === '\b' ? v.slice(0, -1) : v + ch;
			}
		};
		process.stderr.write(prompt); s.setRawMode(true); s.setEncoding('utf8'); s.on('data', on); s.resume();
	});
}

// ---- export --------------------------------------------------------------------------------------
export async function exportContainer(name, flags, log = console.log) {
	const out = typeof flags.out === 'string' ? path.resolve(flags.out) : null;
	if (!out) throw new Error(`dt export container ${name} --out <file> — where the export is written`);
	if (fs.existsSync(out)) throw new Error(`${out} already exists — name a new file`);
	const only = flags.workspaces ?? [];
	for (const w of only) if (typeof w !== 'string' || !WS_NAME.test(w)) throw new Error(`--workspace takes a workspace folder name under ${ROOT} — got "${w}"`);
	const c = await inspectContainer(name);
	if (!c) throw new Error(`no container "${name}" — dt list containers`);
	const encrypt = flags['no-encrypt'] !== true;
	const sealer = encrypt ? await newSeal(await passphrase({ confirm: true })) : null;
	// one read of the root, or one per named workspace so the others never leave the container
	const sources = only.length ? only.map((w) => ({ at: `${ROOT}/${w}`, strip: '' })) : [{ at: ROOT, strip: `${path.posix.basename(ROOT)}/` }];
	const stats = new Map(); const left = new Set(); const skipped = [];
	const decide = (strip) => (e) => {
		const rel = e.name.slice(strip.length).replace(/\/+$/, '');
		if (!e.name.startsWith(strip) || !rel) return null;
		const segs = rel.split('/');
		if (segs.some((s) => LEFT_BEHIND.has(s))) { left.add(segs.slice(0, segs.findIndex((s) => LEFT_BEHIND.has(s)) + 1).join('/')); return null; }
		if (!WS_NAME.test(segs[0]) || (segs.length === 1 && e.type !== DIR)) { if (segs.length === 1) skipped.push(`${rel} (not a workspace folder)`); return null; }
		if (![FILE, DIR, SYMLINK].includes(e.type)) { skipped.push(`${rel} (${e.type === '1' ? 'hard link' : 'device or fifo'})`); return null; }
		const s = stats.get(segs[0]) ?? { files: 0, bytes: 0 }; stats.set(segs[0], s);
		if (e.type === FILE) { s.files++; s.bytes += e.size; }
		return e.type === DIR ? `${rel}/` : rel;
	};
	async function* tar() {
		for (const s of sources) {
			const r = await api('GET', `/containers/${c.Id}/archive?path=${encodeURIComponent(s.at)}`, undefined, { stream: true });
			if (r.status === 404) throw new Error(`${name} has no ${s.at}`);
			ok(r, `read ${s.at} from ${name}`);
			yield* retar(r.res, decide(s.strip));
		}
		yield TAR_END;
	}
	const tmp = `${out}.partial`;
	try {
		await pipeline(Readable.from(tar()), zlib.createGzip(), ...(sealer ? [(src) => seal(src, sealer)] : []), fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
		fs.renameSync(tmp, out);
	} catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
	if (!stats.size) { fs.rmSync(out); throw new Error(`${name} holds no workspace folder under ${ROOT} — nothing was written`); }
	for (const [w, s] of stats) log(`  ${w}  ${s.files} files · ${(s.bytes / 1e6).toFixed(1)} MB`);
	if (left.size) log(`  left behind: ${[...left].join(' · ')}`);
	for (const s of skipped) log(`  skipped: ${s}`);
	log(`✔ exported ${stats.size} workspace(s) from ${name} to ${out} · ${encrypt ? 'encrypted with the owner passphrase' : 'NOT encrypted (--no-encrypt): a plain .tar.gz anyone holding the file can read'}`);
	return 0;
}

// ---- import --------------------------------------------------------------------------------------
/** The name to upload an entry under, null to leave it out (`--workspace`), or a refusal. */
function checkEntry(e, only, found) {
	const name = e.name.replace(/^(\.\/)+/, '');
	const rel = name.replace(/\/+$/, '');
	const segs = rel.split('/');
	const refuse = (why) => { throw new Error(`the export holds "${e.name}", which ${why} — nothing was written`); };
	if (name.startsWith('/')) refuse('is an absolute path');
	if (segs.some((s) => s === '..' || s === '.' || s === '')) refuse(`leaves ${ROOT}`);
	if (!WS_NAME.test(segs[0]) || (segs.length === 1 && e.type !== DIR)) refuse(`is not inside a workspace folder`);
	if (![FILE, DIR, SYMLINK].includes(e.type)) refuse(`is a ${e.type === '1' ? 'hard link' : 'device, fifo or unknown entry'}`);
	if (e.type === SYMLINK) {
		const own = `${ROOT}/${segs[0]}`;
		const to = path.posix.resolve(path.posix.dirname(`${ROOT}/${rel}`), e.linkname);
		if (to !== own && !to.startsWith(`${own}/`)) refuse(`is a symlink to ${e.linkname}, outside its workspace`);
	}
	if (only.size && !only.has(segs[0])) return null;
	found.add(segs[0]);
	return e.type === DIR ? `${rel}/` : rel;
}

export async function importContainer(name, file, flags, log = console.log) {
	if (!file) throw new Error(`dt import container ${name} <file>`);
	const c = await inspectContainer(name);
	if (!c) throw new Error(`no container "${name}" — dt list containers`);
	if (c.State?.Status !== 'running') throw new Error(`${name} is ${c.State?.Status} — import needs it running: dt start container ${name}`);
	const head = Buffer.alloc(8); { const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd); }
	const sealed = head.equals(MAGIC);
	if (!sealed && !(head[0] === 0x1f && head[1] === 0x8b)) throw new Error(`${file} is neither a dreamteamer export nor a .tar.gz`);
	const key = sealed ? await openSeal(file, await passphrase({ confirm: false })) : null;
	if (!sealed) log(`… ${file} is NOT encrypted — reading it as a plain .tar.gz`);
	const only = new Set(flags.workspaces ?? []);
	const read = (found) => [fs.createReadStream(file, { start: sealed ? HEAD + MAC : 0 }), ...(key ? [(src) => unseal(src, key)] : []), zlib.createGunzip(),
		async function* (src) { yield* retar(src, (e) => checkEntry(e, only, found)); yield TAR_END; }];
	// pass 1: every chunk authenticated and every entry checked before anything is written
	const found = new Set();
	await pipeline(...read(found), async (src) => { for await (const _ of src); });
	const missing = [...only].filter((w) => !found.has(w));
	if (missing.length) throw new Error(`the export holds no workspace ${missing.join(', ')} — it holds ${[...found].join(', ') || 'none'}`);
	if (!found.size) throw new Error(`${file} holds no workspace`);
	const targets = [...found].map((w) => `${ROOT}/${w}`);
	// a folder on the container's own layer vanishes with the container — the rule dt-new keeps
	const mounts = (await exec(name, ['cat', '/proc/mounts'])).stdout.split('\n').map((l) => l.split(' ')).filter((m) => m[1]);
	for (const t of targets) {
		const m = mounts.filter(([, at]) => t === at || t.startsWith(at === '/' ? '/' : `${at}/`)).sort((a, b) => b[1].length - a[1].length)[0];
		if (!m || ['overlay', 'tmpfs', 'ramfs'].includes(m[2])) throw new Error(`${t} would land on ${m ? m[2] : 'an unknown filesystem'}, not a volume, and vanish with the container — import into the container whose own workspace it is (dt start container <w> makes ${ROOT}/<w> a volume). Nothing was written`);
	}
	const full = [];
	for (const t of targets) { const r = await exec(name, ['find', t, '-mindepth', '1', '-maxdepth', '1', '-print', '-quit']); if (r.code === 0 && r.stdout.trim()) full.push(t); }
	if (full.length && flags.replace !== true) throw new Error(`${full.join(', ')} already hold${full.length === 1 ? 's' : ''} files in ${name} — --replace empties and replaces ${full.length === 1 ? 'it' : 'them'}. Nothing was written`);
	for (const t of full) { const r = await exec(name, ['find', t, '-mindepth', '1', '-delete'], { user: 'root' }); if (r.code !== 0) throw new Error(`emptying ${t} failed (exit ${r.code}) — ${r.stderr.trim()}`); }
	// pass 2: the same checks again on the way up, so a file changed between the passes is still refused
	await pipeline(...read(new Set()), async (src) => ok(await api('PUT', `/containers/${c.Id}/archive?path=${encodeURIComponent(ROOT)}&noOverwriteDirNonDir=true`, undefined, { send: Readable.from(src) }), `write ${ROOT} in ${name}`));
	const own = await exec(name, ['chown', '-R', 'node:node', ...targets], { user: 'root' });
	if (own.code !== 0) throw new Error(`chown of ${targets.join(' ')} failed (exit ${own.code}) — ${own.stderr.trim()}`);
	log(`✔ imported ${targets.join(', ')} into ${name}${full.length ? ` · replaced ${full.join(', ')}` : ''} · owned by node`);
	return 0;
}

/** `dt export|import container <name> …` → exit code. */
export async function archiveCommand(verb, target, args) {
	const { flags, pos } = parseFlags(args);
	if ('passphrase' in flags) throw new Error('the passphrase is never a flag (every local user\'s `ps` reads argv) — set DT_EXPORT_PASSPHRASE, or let the prompt ask');
	const bad = Object.keys(flags).find((f) => f !== 'workspaces' && !FLAGS[verb].includes(f));
	if (bad) throw new Error(`unknown flag "--${bad}" on \`dt ${verb} container\` — known: ${FLAGS[verb].map((f) => `--${f}`).join(', ')}`);
	const name = target.id ?? pos.shift();
	if (target.collection !== 'containers' || !name) throw new Error(verb === 'export' ? 'dt export container <name> [--workspace <w>]... --out <file> [--no-encrypt]' : 'dt import container <name> <file> [--workspace <w>]... [--replace]');
	return verb === 'export' ? exportContainer(name, flags) : importContainer(name, pos[0], flags);
}
