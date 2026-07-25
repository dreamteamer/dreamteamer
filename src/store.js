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
import { parseRecord, patternRe, fmtAjvError, unknownFields } from './records.js';

const EXT = { md: '.md', yaml: '.yaml', json: '.json' };

export class Store {
	constructor({ root }) {
		this.root = root;
		this.runtime = path.join(root, '.dreamteamer');
		this.ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true, coerceTypes: 'array' });
		addFormats(this.ajv);
		this.ajv.addFormat('markdown', true);
		this.descriptors = new Map();
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
		if (d.storage.shape === 'folder') {
			if (!d.storage.entry) throw new Error(`collection "${d.name}" is folder-shape but declares no storage.entry`);
			return path.join(this.dir(d), id, d.storage.entry);
		}
		return path.join(this.dir(d), `${id}.${d.storage.suffix}${EXT[d.storage.codec ?? 'md']}`);
	}

	// the on-disk unit of a record: its folder for folder shapes, its file otherwise
	recordRoot(d, id) {
		return d.storage.shape === 'folder' ? path.join(this.dir(d), id) : this.filePath(d, id);
	}

	ids(collection) {
		const d = this.descriptor(collection);
		const dir = this.dir(d);
		if (!fs.existsSync(dir)) return new Map();
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
		fs.mkdirSync(path.dirname(file), { recursive: true });
		atomicWrite(file, serialize(d, fields));
		this.commit([file], `dreamteamer: ${collection} add ${id}`);
		return { id, file };
	}

	set(collection, id, changes) {
		const d = this.writableDescriptor(collection);
		const { fields, file } = this.read(collection, id);
		const next = { ...fields, ...changes };
		for (const [k, v] of Object.entries(changes)) if (v === null || v === '') delete next[k];
		this.validate(d, next);
		atomicWrite(file, serialize(d, next));
		this.commit([file], `dreamteamer: ${collection} set ${id}`);
		return { id, file };
	}

	rm(collection, id, { force = false } = {}) {
		const d = this.writableDescriptor(collection);
		this.read(collection, id); // existence check
		const inbound = this.findInboundRefs(`${collection}/${id}`);
		if (inbound.length && !force) {
			throw new Error(`${collection}/${id} is referenced by:\n${inbound.map((f) => `  ${f}`).join('\n')}\nfix the references or pass --force. nothing was removed.`);
		}
		const unit = this.recordRoot(d, id); // folder-shape: the whole folder goes, not just the entry file
		fs.rmSync(unit, { recursive: true });
		this.commit([unit], `dreamteamer: ${collection} rm ${id}`);
		return { id, inboundIgnored: force ? inbound.length : 0 };
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
		fs.mkdirSync(path.dirname(newUnit), { recursive: true });
		fs.renameSync(oldUnit, newUnit);
		pruneEmptyDirs(path.dirname(oldUnit), this.dir(d)); // cross-partition renames leave empty date dirs
		// rewrite ALL inbound references (data + state + system SOURCES) in the same commit
		const { touched, rewrites } = this.rewriteRefs(`${collection}/${oldId}`, `${collection}/${newId}`);
		this.commit([oldUnit, newUnit, ...touched], `dreamteamer: ${collection} rename ${oldId} → ${newId}`);
		return { id: newId, rewrites, touched: touched.length };
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

	sourceRoots() {
		const roots = [this.root];
		const modulesDir = path.join(this.root, 'modules');
		if (fs.existsSync(modulesDir)) {
			for (const name of fs.readdirSync(modulesDir).sort()) {
				const p = path.join(modulesDir, name, 'package.json');
				try { if ('dreamteamer' in JSON.parse(fs.readFileSync(p, 'utf8'))) roots.push(path.join(modulesDir, name)); } catch { /* skip */ }
			}
		}
		return roots;
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

	rewriteRefs(oldRef, newRef) {
		const re = this.refRegex(oldRef);
		const touched = [];
		let rewrites = 0;
		for (const f of this.recordFiles()) {
			const text = fs.readFileSync(f, 'utf8');
			re.lastIndex = 0;
			if (!re.test(text)) continue;
			const next = text.replace(this.refRegex(oldRef), newRef);
			rewrites += (text.match(this.refRegex(oldRef)) ?? []).length;
			atomicWrite(f, next);
			touched.push(f);
		}
		return { touched, rewrites };
	}

	commit(files, subject) {
		const rel = files.map((f) => path.relative(this.root, f));
		execFileSync('git', ['add', '--all', '--', ...rel], { cwd: this.root });
		execFileSync('git', ['commit', '--quiet', '-m', subject, '--', ...rel], { cwd: this.root });
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

function* walk(dir) {
	for (const name of fs.readdirSync(dir).sort()) {
		if (name.startsWith('.')) continue;
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) yield* walk(p);
		else yield p;
	}
}
