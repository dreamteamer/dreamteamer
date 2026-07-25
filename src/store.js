// the validating store — every tooling write goes through here:
// parse → coerce → defaults → validate (HARD: rejected before disk) →
// atomic write → one git commit. direct file edits stay first-class and are
// covered by `check` after the fact.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { load, dump } from './yaml.js';
import { generateId } from './template.js';
import { parseRecord, parseRecordText, patternRe, fmtAjvError, unknownFields, walk, EXT, assertSafeId } from './records.js';
import { discoverModules } from './compile.js';

export class Store {
	constructor({ root }) {
		this.root = root;
		this.runtime = path.join(root, '.dreamteamer');
		this.ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true, coerceTypes: 'array' });
		addFormats(this.ajv);
		this.ajv.addFormat('markdown', true);
		this.descriptors = new Map();
		this._idsCache = new Map(); // collection -> { key, ids } (see ids())
		const descDir = path.join(this.runtime, 'system', 'collections');
		if (!fs.existsSync(descDir)) throw new Error('no compiled runtime — run `dreamteamer compile` first');
		for (const f of fs.readdirSync(descDir).sort()) {
			if (!f.endsWith('.collection.yaml')) continue;
			const d = load(fs.readFileSync(path.join(descDir, f), 'utf8'));
			this.descriptors.set(d.name, d);
		}
	}

	descriptor(collection) {
		const d = this.descriptors.get(collection);
		if (!d) throw new Error(`unknown collection "${collection}" (known: ${[...this.descriptors.keys()].join(', ')})`);
		return d;
	}

	// data/state collections are writable through the store; system-stored
	// (knowhow/meta) entities are edited as SOURCES + compile — refuse politely.
	writableDescriptor(collection) {
		const d = this.descriptor(collection);
		if (d.storage.path.startsWith('system/')) {
			throw new Error(`"${collection}" records are system sources — edit the file under the owning module (or system/) and run \`dreamteamer compile\``);
		}
		return d;
	}

	dir(d) {
		return d.storage.path.startsWith('system/')
			? path.join(this.runtime, d.storage.path)
			: path.join(this.root, d.storage.path);
	}

	filePath(d, id) {
		assertSafeId(id); // never fs-join an id that can climb out of the collection
		if (d.storage.shape === 'folder') {
			if (!d.storage.entry) throw new Error(`collection "${d.name}" is folder-shape but declares no storage.entry`);
			return path.join(this.dir(d), id, d.storage.entry);
		}
		return path.join(this.dir(d), `${id}.${d.storage.suffix}${EXT[d.storage.codec ?? 'md']}`);
	}

	// the on-disk unit of a record: its folder for folder shapes, its file otherwise
	recordRoot(d, id) {
		assertSafeId(id);
		return d.storage.shape === 'folder' ? path.join(this.dir(d), id) : this.filePath(d, id);
	}

	// current HEAD — one cheap rev-parse per cache check vs a multi-thousand-file walk
	gitHead() {
		try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.root }).toString().trim(); } catch { return 'no-git'; }
	}

	ids(collection) {
		const d = this.descriptor(collection);
		const dir = this.dir(d);
		if (!fs.existsSync(dir)) return new Map();
		// memoized per collection, keyed by (HEAD sha, collection dir mtime): every tool
		// write commits (HEAD moves) and every store mutation clears its entry below;
		// direct top-level edits move the dir mtime. honest gap: a DEEP direct edit that
		// adds/removes a record without touching HEAD or the top dir mtime can serve one
		// stale read — acceptable, tool writes always commit and `check` covers hand edits.
		const key = `${this.gitHead()}:${fs.statSync(dir).mtimeMs}`;
		const hit = this._idsCache.get(collection);
		if (hit?.key === key) return hit.ids;
		const ids = this._walkIds(d, dir);
		this._idsCache.set(collection, { key, ids });
		return ids;
	}

	_walkIds(d, dir) {
		const ids = new Map();
		if (d.storage.shape === 'folder') {
			for (const e of fs.readdirSync(dir).sort()) {
				if (e.startsWith('.')) continue;
				const main = path.join(dir, e, d.storage.entry ?? 'SKILL.md');
				if (fs.existsSync(main)) ids.set(e, main);
			}
			return ids;
		}
		const tail = `.${d.storage.suffix}${EXT[d.storage.codec ?? 'md']}`;
		for (const f of walk(dir)) {
			const r = path.relative(dir, f);
			if (r.endsWith(tail)) ids.set(r.slice(0, -tail.length), f);
		}
		return ids;
	}

	read(collection, id) {
		const d = this.descriptor(collection);
		const file = this.ids(collection).get(id);
		if (!file) throw new Error(`${collection}/${id}: no such record`);
		return { fields: parseRecord(file, d, bodyField(d)), file, descriptor: d };
	}

	// list-path reader: ONE directory walk for the whole collection (review finding 2:
	// per-id read() re-walked the dir — O(N²) lists, 46s at 3k records).
	*readAll(collection) {
		const d = this.descriptor(collection);
		const bf = bodyField(d);
		for (const [id, file] of this.ids(collection)) {
			yield { id, file, fields: parseRecord(file, d, bf) };
		}
	}

	// restore a record to its content at `hash` — validated like any other write, one commit.
	revert(collection, id, hash) {
		const d = this.writableDescriptor(collection);
		const { file } = this.read(collection, id);
		const relPath = path.relative(this.root, file);
		let previousContent;
		try {
			previousContent = execFileSync('git', ['show', `${hash}:${relPath}`], { cwd: this.root }).toString();
		} catch {
			throw new Error(`${collection}/${id}: no content at ${hash} for ${relPath} — nothing was reverted.`);
		}
		const current = fs.readFileSync(file, 'utf8');
		if (current === previousContent) return { id, reverted: false };
		// parse + validate the historical content before it touches disk
		const tmpFields = parseRecordText(previousContent, d, bodyField(d));
		this.validate(d, tmpFields);
		return this.withWriteLock(() => {
			this._idsCache.delete(collection); // every mutation drops the memo — cleared even if the commit rolls back
			atomicWrite(file, previousContent);
			this.commit([file], `dreamteamer: ${collection} revert ${id} to ${String(hash).slice(0, 7)}`, () => atomicWrite(file, current));
			return { id, reverted: true, hash };
		});
	}

	// ---- validation (hard) ---------------------------------------------------

	validate(d, fields, { skipRefs = false } = {}) {
		// hard at the tools includes UNKNOWN fields: a typo'd key must never land on disk
		const unknown = unknownFields(d.schema, fields);
		if (unknown.length) throw new Error(`unknown field(s) for this collection: ${unknown.join(', ')} — nothing was written.`);
		const validate = this.ajv.compile(d.schema); // useDefaults mutates: defaults materialize
		if (!validate(fields)) {
			const msgs = validate.errors.map((e) => '  ' + fmtAjvError(e, fields));
			throw new Error(`validation failed:\n${msgs.join('\n')}\nnothing was written.`);
		}
		if (!skipRefs) this.checkRefs(d, fields);
		return fields;
	}

	checkRefs(d, fields, prefix = []) {
		for (const [key, s] of Object.entries(d.schema.properties ?? {})) {
			const target = s?.['x-reference'] ?? s?.items?.['x-reference'];
			if (!target) continue;
			const raw = fields[key];
			if (raw == null) continue;
			for (const value of Array.isArray(raw) ? raw : [raw]) {
				if (typeof value !== 'string' || value.startsWith('@')) continue;
				const slash = value.indexOf('/');
				if (slash < 1) throw new Error(`${key}: reference "${value}" is not <collection>/<id> — nothing was written.`);
				const coll = value.slice(0, slash);
				const id = value.slice(slash + 1);
				if (target !== '*' && coll !== target) throw new Error(`${key}: reference "${value}" must target collection "${target}" — nothing was written.`);
				if (!this.descriptors.has(coll)) throw new Error(`${key}: reference "${value}" targets unknown collection "${coll}" — nothing was written.`);
				if (!this.ids(coll).has(id)) throw new Error(`${key}: dangling reference "${value}" — no such record. nothing was written.`);
			}
		}
	}

	// ---- verbs -----------------------------------------------------------------

	add(collection, fields, { id: explicitId } = {}) {
		const d = this.writableDescriptor(collection);
		this.validate(d, fields);
		const id = explicitId ?? generateId(d.id?.generate ?? '{{ name | slug }}', fields, [...this.ids(collection).keys()]);
		if (d.id?.pattern && !patternRe(d.id.pattern).test(id)) {
			throw new Error(`id "${id}" does not match pattern ${d.id.pattern} — nothing was written.`);
		}
		const file = this.filePath(d, id);
		if (fs.existsSync(file)) throw new Error(`${collection}/${id} already exists — nothing was written.`);
		return this.withWriteLock(() => {
			this._idsCache.delete(collection);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			atomicWrite(file, serialize(d, fields));
			this.commit([file], `dreamteamer: ${collection} add ${id}`, () => {
				fs.rmSync(file, { force: true });
				pruneEmptyDirs(path.dirname(file), this.dir(d));
			});
			return { id, file };
		});
	}

	set(collection, id, changes) {
		const d = this.writableDescriptor(collection);
		const { fields, file } = this.read(collection, id);
		const previous = fs.readFileSync(file, 'utf8');
		const next = { ...fields, ...changes };
		for (const [k, v] of Object.entries(changes)) if (v === null || v === '') delete next[k];
		this.validate(d, next);
		return this.withWriteLock(() => {
			this._idsCache.delete(collection);
			atomicWrite(file, serialize(d, next));
			this.commit([file], `dreamteamer: ${collection} set ${id}`, () => atomicWrite(file, previous));
			return { id, file };
		});
	}

	rm(collection, id, { force = false } = {}) {
		const d = this.writableDescriptor(collection);
		this.read(collection, id); // existence check
		const inbound = this.findInboundRefs(`${collection}/${id}`);
		if (inbound.length && !force) {
			throw new Error(`${collection}/${id} is referenced by:\n${inbound.map((f) => `  ${f}`).join('\n')}\nfix the references or pass --force. nothing was removed.`);
		}
		const unit = this.recordRoot(d, id); // folder-shape: the whole folder goes, not just the entry file
		return this.withWriteLock(() => {
			this._idsCache.delete(collection);
			fs.rmSync(unit, { recursive: true });
			this.commit([unit], `dreamteamer: ${collection} rm ${id}`, () => {
				execFileSync('git', ['checkout', '--quiet', 'HEAD', '--', path.relative(this.root, unit)], { cwd: this.root });
			});
			return { id, inboundIgnored: force ? inbound.length : 0 };
		});
	}

	rename(collection, oldId, newId) {
		const d = this.writableDescriptor(collection);
		this.read(collection, oldId); // existence check
		if (oldId === newId) return { id: newId, rewrites: 0 };
		if (d.id?.pattern && !patternRe(d.id.pattern).test(newId)) {
			throw new Error(`id "${newId}" does not match pattern ${d.id.pattern} — nothing was renamed.`);
		}
		const oldUnit = this.recordRoot(d, oldId); // folder-shape: move the WHOLE folder
		const newUnit = this.recordRoot(d, newId);
		if (fs.existsSync(newUnit)) throw new Error(`${collection}/${newId} already exists — nothing was renamed.`);
		return this.withWriteLock(() => {
			this._idsCache.delete(collection);
			fs.mkdirSync(path.dirname(newUnit), { recursive: true });
			fs.renameSync(oldUnit, newUnit);
			pruneEmptyDirs(path.dirname(oldUnit), this.dir(d)); // cross-partition renames leave empty date dirs
			// rewrite inbound references (frontmatter/structured always; prose only via wikilinks)
			const { touched, rewrites, skipped } = this.rewriteRefs(`${collection}/${oldId}`, `${collection}/${newId}`);
			this.commit([oldUnit, newUnit, ...touched], `dreamteamer: ${collection} rename ${oldId} → ${newId}`, () => {
				fs.mkdirSync(path.dirname(oldUnit), { recursive: true });
				fs.renameSync(newUnit, oldUnit);
				pruneEmptyDirs(path.dirname(newUnit), this.dir(d));
				if (touched.length) execFileSync('git', ['checkout', '--quiet', 'HEAD', '--', ...touched.map((f) => path.relative(this.root, f))], { cwd: this.root });
			});
			for (const s of skipped) {
				console.warn(`⚠ ${path.relative(this.root, s.file)}: ${s.count} raw-prose occurrence(s) of ${collection}/${oldId} left untouched — only [[wikilinks]] are maintained in bodies (decision 7)`);
			}
			return { id: newId, rewrites, touched: touched.length, skipped: skipped.length };
		});
	}

	// exact-ref matching with a boundary so contacts/jane never matches contacts/jane-doe
	refRegex(ref) {
		return new RegExp(`${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`, 'g');
	}

	*recordFiles() {
		for (const [name, d] of this.descriptors) {
			// for system-stored collections, inbound-ref surgery targets SOURCES, not the runtime
			if (d.storage.path.startsWith('system/')) {
				for (const srcRoot of this.sourceRoots()) {
					const dir = path.join(srcRoot, d.storage.path);
					if (fs.existsSync(dir)) yield* walk(dir);
				}
			} else {
				const dir = path.join(this.root, d.storage.path);
				if (fs.existsSync(dir)) yield* walk(dir);
			}
		}
	}

	// all three channels via THE discovery (review finding 10: this layer never learned
	// decision 24 — rename silently skipped git_modules sources). npm copies are foreign
	// installed artifacts, never rewrite targets; inline + git clones are ours.
	sourceRoots() {
		let pkg = {};
		try { pkg = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8')); } catch { /* no pkg */ }
		return [this.root, ...discoverModules(this.root, pkg).modules.filter((m) => m.channel !== 'npm').map((m) => m.root)];
	}

	findInboundRefs(ref) {
		const re = this.refRegex(ref);
		const hits = [];
		for (const f of this.recordFiles()) {
			const text = fs.readFileSync(f, 'utf8');
			re.lastIndex = 0;
			if (re.test(text)) hits.push(path.relative(this.root, f));
		}
		return hits;
	}

	// decision 7 (un-parked): structured surfaces (frontmatter, yaml/json records) rewrite
	// unconditionally; PROSE bodies rewrite only inside [[collection/id]] / [[collection/id|label]]
	// wikilinks — raw-text matching corrupted look-alike URLs (review finding 4). raw body
	// occurrences are counted and reported, never touched.
	rewriteRefs(oldRef, newRef) {
		const touched = [];
		const skipped = [];
		let rewrites = 0;
		const escaped = oldRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const wikiRe = new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, 'g');
		for (const f of this.recordFiles()) {
			const text = fs.readFileSync(f, 'utf8');
			let next;
			let count = 0;
			if (f.endsWith('.md')) {
				// prose scoping applies to EVERY .md — a frontmatter-less file is all body
				// (docs-audit catch: it used to fall through to raw replacement)
				const fm = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/.exec(text);
				const headText = fm ? fm[1] : '';
				const bodyText = fm ? fm[2] : text;
				const head = headText.replace(this.refRegex(oldRef), () => (count++, newRef));
				const body = bodyText.replace(wikiRe, (_, label) => (count++, `[[${newRef}${label ?? ''}]]`));
				next = head + body;
				const raw = (body.match(this.refRegex(oldRef)) ?? []).length;
				if (raw) skipped.push({ file: f, count: raw });
			} else {
				next = text.replace(this.refRegex(oldRef), () => (count++, newRef));
			}
			if (count === 0) continue;
			rewrites += count;
			atomicWrite(f, next);
			touched.push(f);
		}
		return { touched, rewrites, skipped };
	}

	// ---- write serialization + rollback (review finding 3; reinstates the v2 commit
	// queue idea in sync form). within ONE process Node's sync fs/exec already serializes;
	// the lock guards CLI-beside-server cross-process races on .git/index.lock. a commit
	// failure UNDOES the write, so "one mutation = one commit" fails CLOSED and
	// "nothing was written" stays true.
	withWriteLock(fn) {
		const lock = path.join(this.runtime, '.write-lock');
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		const deadline = Date.now() + 5000;
		for (;;) {
			try { fs.mkdirSync(lock); break; } catch (e) {
				if (e.code !== 'EEXIST') throw e;
				try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.rmdirSync(lock); continue; } } catch { /* raced the holder */ }
				if (Date.now() > deadline) throw new Error('another dreamteamer process holds the write lock (.dreamteamer/.write-lock) — retry, or remove it if nothing is running.');
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // sync sleep, no busy spin
			}
		}
		try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
	}

	commit(files, subject, undo) {
		const rel = files.map((f) => path.relative(this.root, f));
		try {
			execFileSync('git', ['add', '--all', '--', ...rel], { cwd: this.root });
			execFileSync('git', ['commit', '--quiet', '-m', subject, '--', ...rel], { cwd: this.root });
		} catch (e) {
			try { execFileSync('git', ['reset', '--quiet', '--', ...rel], { cwd: this.root }); } catch { /* nothing staged */ }
			if (undo) {
				try { undo(); } catch (u) {
					throw new Error(`git commit failed AND rollback failed (${u.message}) — inspect the working tree. original: ${e.message.split('\n')[0]}`);
				}
			}
			throw new Error(`git commit failed — the write was rolled back, nothing was changed. (${e.message.split('\n')[0]})`);
		}
	}
}

export function bodyField(d) {
	return Object.entries(d.schema.properties ?? {}).find(([, s]) => s?.['x-body'])?.[0];
}


// remove now-empty parent dirs up to (not including) the collection root
function pruneEmptyDirs(dir, stopAt) {
	while (dir !== stopAt && dir.startsWith(stopAt) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
		fs.rmdirSync(dir);
		dir = path.dirname(dir);
	}
}

export function serialize(d, fields) {
	const codec = d.storage.codec ?? 'md';
	if (codec === 'json') return JSON.stringify(fields, null, 2) + '\n';
	if (codec === 'yaml') return dump(fields);
	const bf = bodyField(d);
	const fm = { ...fields };
	let body = '';
	if (bf && fm[bf] !== undefined) {
		body = String(fm[bf]).trim();
		delete fm[bf];
	}
	return `---\n${dump(fm)}---\n${body ? body + '\n' : ''}`;
}

export function atomicWrite(file, content) {
	if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false; // true no-op
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
	return true;
}
