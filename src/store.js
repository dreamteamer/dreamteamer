// the validating store — every tooling write goes through here:
// parse → coerce → defaults → validate (HARD: rejected before disk) →
// atomic write → one git commit. direct file edits stay first-class and are
// covered by `check` after the fact.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { dump } from './yaml.js';
import { generateId } from './template.js';
import { parseRecord, parseRecordText, patternRe, fmtAjvError, unknownFields, walk, EXT, assertSafeId, idFromRecordPath, MAX_RECORD_BYTES } from './records.js';
import { normalizeRecord } from './temporal.js';
import { NO_RUNTIME, sourceHint, loadDescriptors, runtimeDir, namespaces as compiledNamespaces, sourceRoots as compiledSourceRoots } from './runtime.js';
import { parseRef } from './namespace.js';
import { refTargetsOf } from './ref.js';
import { relationsOf } from './relations.js';

// git calls whose failure we CATCH must not print git's own error: execFileSync forwards the
// child's stderr to ours unless told otherwise, so a handled "not a git repository" still
// reached the user's terminal. stdout stays piped because we read it.
const QUIET = ['ignore', 'pipe', 'ignore'];

export class Store {
	constructor({ root, pkg }) {
		this.root = root;
		this.runtime = runtimeDir(root);
		// Committing is POLICY, not durability — a write is on disk either way. Default OFF:
		// `dt commit` is what publishes. `"auto-commit": true` restores the old behaviour of one
		// commit per mutation.
		this.autoCommit = (pkg ?? readPkg(root)).dreamteamer?.['auto-commit'] === true;
		this.ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true, coerceTypes: 'array' });
		addFormats(this.ajv);
		this.ajv.addFormat('markdown', true);
		this._idsCache = new Map(); // collection -> { key, ids } (see ids())
		const descriptors = loadDescriptors(root);
		if (!descriptors) throw new Error(NO_RUNTIME);
		this.descriptors = descriptors;
		// The closed set every reference is split against (see src/namespace.js). Read once per Store:
		// it is compile output, and a Store is already rebuilt whenever the runtime changes.
		this.namespaces = compiledNamespaces(root);
	}

	descriptor(collection) {
		const d = this.descriptors.get(collection);
		if (!d) throw new Error(`unknown collection "${collection}" (known: ${[...this.descriptors.keys()].join(', ')})`);
		return d;
	}

	// data/state collections are writable through the store; runtime-based (knowhow/meta)
	// entities are edited as SOURCES + compile — refuse politely.
	writableDescriptor(collection) {
		const d = this.descriptor(collection);
		if (d.storage.base === 'runtime') {
			// Two different runtime shapes, and pointing at the wrong one is worse than saying
			// nothing: a STAGED kind (skills, commands, ui-views…) really does have a source file
			// under `modules/<module>/<kind>/`, while a PROJECTED one (modules) has no such folder
			// and never should — its source is the module's package.json. `x-source` says which,
			// stated as data on the descriptor so the store never has to know what a module is.
			const from = sourceHint(d);
			throw new Error(`"${collection}" records are compiled sources — edit ${from} and run \`dreamteamer compile\``);
		}
		return d;
	}

	// Can the store rewrite this collection's records AT ALL? The two shapes it cannot are the same
	// pair `applyMirrorEdits` bails on: a runtime-based record is a build artifact under
	// `.dreamteamer/` whose source lives elsewhere, and a `codec: file` record's bytes ARE the record
	// — `serialize` has no branch for it, so a write would replace an SVG with frontmatter. A
	// predicate rather than a throw, because the callers that need this are CHOOSING a path (rm's
	// set-null falls back to restrict) rather than refusing a request.
	canRewrite(collection) {
		const d = this.descriptors.get(collection);
		return !!d && d.storage.base !== 'runtime' && (d.storage.codec ?? 'md') !== 'file';
	}

	// Relations, decoded ONCE per Store — the same reasoning as `namespaces` in the constructor: this
	// is compile output, and a Store is already rebuilt whenever the runtime changes.
	relations() { return (this._relations ??= relationsOf(this.descriptors)); }

	// A generated mirror sits on the TARGET's schema, so it looks like any other field to whoever
	// holds the descriptor — and `readOnly` is documentation, not a gate: ajv does not enforce it.
	// Left alone, a hand-set mirror is a value the engine recomputes from the owning side, and the
	// two disagree silently. Refuse instead, and name the write that WOULD have worked: "this field
	// is generated" without the owning side is a dead end.
	refuseMirrorWrites(collection, id, changed) {
		const relations = this.relations();
		for (const key of changed) {
			const r = relations.find((rel) => rel.target === collection && rel.mirror === key);
			if (r) throw new Error(`${key} is generated from ${r.owner}.${r.field} — set that instead: dreamteamer set ${r.owner}/<id> ${r.field}=${collection}/${id ?? '<id>'} — nothing was written.`);
		}
	}

	/** Mirror maintenance for ONE owner-record write: rewrites every TARGET whose mirror has to change
	 *  so it says what `after` implies, and hands back those files plus the undo that puts them back.
	 *  The values written are exactly what `expectedMirrors` computes, which is what `check` compares
	 *  against — the two read the same relation rows, so they cannot disagree about what a mirror holds.
	 *
	 *  Runs INSIDE withWriteLock, after the owner file is on disk. Nothing is validated here: an attach
	 *  was proved to exist by `checkRefs` before the lock, and a detach is removal, which cannot dangle.
	 *
	 *  ⚠ ALL-OR-NOTHING, by its own hand. The one refusal it can raise (x-unique) is discoverable only
	 *  ON a target, i.e. partway through a loop that may already have rewritten other targets — so a
	 *  throw undoes its own work before it propagates, and the caller is left with exactly one thing to
	 *  roll back: the owner write.
	 *
	 *  @returns {{files: string[], undo: () => void}} */
	applyMirrorEdits(d, id, before, after) {
		const self = `${d.name}/${id}`;
		// ⚠ `before` comes straight off DISK while `after` has been through validate(), which qualifies
		// bare refs — so diffing them as written strings read `meeting: standup` (hand-edited, or
		// written before namespaces) as a detach of "standup", which parses as nothing and is skipped,
		// plus an attach of "meetings/standup". The old target kept its link forever and a GREEN
		// `dt set` was what created the staleness. Qualify a COPY: qualifyBareRefs mutates, and
		// `before` is the caller's live record.
		const prior = before ? { ...before } : null;
		if (prior) this.qualifyBareRefs(d, prior);
		const files = [];
		const undos = [];
		// a COPY before reversing: `undo` is handed to `commit`, and an in-place reverse would make a
		// second call replay the writes forwards rather than unwind them.
		const rollback = () => { for (const u of [...undos].reverse()) u(); };
		const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
		try {
			// EVERY row whose owner is this collection, never the first match: a union FK
			// (`x-reference: [a, b]`) decodes to one relation row PER TARGET, all sharing one owner
			// field, and each row maintains only the refs naming its own target — which is what the
			// `parsed.collection` guard in `touch` enforces. Finding one row would maintain one member
			// of the union and silently leave the others stale.
			for (const rel of this.relations()) {
				if (rel.owner !== d.name) continue;
				const was = new Set(toArr(prior?.[rel.field]));
				const now = new Set(toArr(after?.[rel.field]));
				const touch = (ref, fn) => {
					const parsed = parseRef(ref, this.namespaces);
					if (!parsed || parsed.collection !== rel.target) return; // malformed, or another union member — not this row's business
					// TWO TARGETS THAT CANNOT HOLD A MIRROR, and compile refuses both (see stampMirror).
					// This is the belt to that brace, because getting it wrong DESTROYS bytes rather than
					// merely mis-linking. `writableDescriptor` first: a runtime-based target's records are
					// compiled from sources, and writing one means editing a build artifact under
					// `.dreamteamer/` that is gitignored and gone at the next compile — refuse, loudly.
					const td = this.writableDescriptor(rel.target);
					// A `codec: file` record's bytes ARE the record: `read` derives its fields and
					// `serialize` has no branch for it, so this line would replace an SVG with frontmatter.
					// BAIL rather than throw — an unwritten mirror is a `check` violation someone can act
					// on; overwritten bytes are simply gone.
					if ((td.storage.codec ?? 'md') === 'file') return;
					// A DETACH can name a target that is already gone: the owner outlived it (a `--force`
					// rm), and its FK is the dangling reference `check` reports. There is no mirror left
					// to edit and `read` would throw, turning someone else's stale data into a refusal of
					// this write. An attach never lands here missing — checkRefs proved it before the lock.
					if (!this.ids(rel.target).has(parsed.id)) return;
					const { fields, file } = this.read(rel.target, parsed.id);
					const previous = fs.readFileSync(file, 'utf8');
					fn(fields, parsed.id);
					atomicWrite(file, serialize(td, fields));
					this._idsCache.delete(rel.target); // every mutation drops the memo, exactly as the verbs do for their own collection
					files.push(file);
					undos.push(() => atomicWrite(file, previous));
				};
				for (const ref of [...was].filter((x) => !now.has(x))) touch(ref, (f) => {
					// scoped to SELF: a unique mirror naming someone else belongs to that someone else,
					// and a list mirror holds every other owner's claim alongside this one.
					if (rel.unique) { if (f[rel.mirror] === self) delete f[rel.mirror]; }
					else f[rel.mirror] = toArr(f[rel.mirror]).filter((x) => x !== self);
					// the last element takes the KEY with it. `[]` and absent read the same to `check`,
					// but only absent is what the record looks like before anything ever attached to it,
					// and a file accumulating empty keys is derived state leaking into the source.
					if (Array.isArray(f[rel.mirror]) && f[rel.mirror].length === 0) delete f[rel.mirror];
				});
				for (const ref of [...now].filter((x) => !was.has(x))) touch(ref, (f, tid) => {
					if (rel.unique) {
						// The FK is one-to-one, so the mirror is a SCALAR and physically cannot hold a
						// second claimant. Refusing here rather than overwriting is what keeps the owning
						// side the truth: the alternative silently unlinks whoever got there first.
						if (f[rel.mirror] && f[rel.mirror] !== self) {
							throw new Error(`${rel.field}: ${rel.target}/${tid} already has a ${rel.mirror} (${f[rel.mirror]}) — x-unique — nothing was written.\n  if that claim is STALE, dreamteamer relations rebuild ${rel.target} recomputes it from the owning side.`);
						}
						f[rel.mirror] = self;
					} else {
						// Sorted, because `expectedMirrors` sorts and `check` compares against it. Deduped,
						// because `was`/`now` are compared as written STRINGS: a hand-edited bare FK is
						// qualified on its way through validate(), so an untouched link reads as a detach of
						// `standup` plus an attach of `meetings/standup` and the mirror would grow a second
						// copy of self.
						f[rel.mirror] = [...new Set([...toArr(f[rel.mirror]), self])].sort();
					}
				});
			}
		} catch (e) {
			rollback();
			throw e;
		}
		return { files, undo: rollback };
	}

	dir(d) {
		return path.join(d.storage.base === 'runtime' ? this.runtime : this.root, d.storage.path);
	}

	filePath(d, id, ext) {
		assertSafeId(id); // never fs-join an id that can climb out of the collection
		if (d.storage.shape === 'folder') {
			if (!d.storage.entry) throw new Error(`collection "${d.name}" is folder-shape but declares no storage.entry`);
			return path.join(this.dir(d), id, d.storage.entry);
		}
		if ((d.storage.codec ?? 'md') === 'file') {
			// An opaque record's extension is not derivable from its id. A caller that WRITES says what
			// it is; a caller that reads goes through the id index instead (recordRoot, below).
			if (!ext) throw new Error(`collection "${d.name}" is \`codec: file\` — its path needs the file's extension`);
			return path.join(this.dir(d), `${id}.${d.storage.suffix}.${ext}`);
		}
		return path.join(this.dir(d), `${id}.${d.storage.suffix}${EXT[d.storage.codec ?? 'md']}`);
	}

	// the on-disk unit of a record: its folder for folder shapes, its file otherwise
	recordRoot(d, id) {
		assertSafeId(id);
		if (d.storage.shape === 'folder') return path.join(this.dir(d), id);
		// Only the index knows an opaque record's extension, so the on-disk unit is looked up rather
		// than derived. An unknown id is the caller's error either way — `read` says so first.
		if ((d.storage.codec ?? 'md') === 'file') {
			const file = this.ids(d.name).get(id);
			if (!file) throw new Error(`${d.name}/${id}: no such record`);
			return file;
		}
		return this.filePath(d, id);
	}

	// current HEAD — one cheap rev-parse per cache check vs a multi-thousand-file walk
	gitHead() {
		try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.root, stdio: QUIET }).toString().trim(); } catch { return 'no-git'; }
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
		for (const f of walk(dir)) {
			const id = idFromRecordPath(d, path.relative(dir, f));
			if (id !== null) ids.set(id, f);
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
		const { fields: currentFields, file } = this.read(collection, id);
		const relPath = path.relative(this.root, file);
		let previousContent;
		try {
			previousContent = execFileSync('git', ['show', `${hash}:${relPath}`], { cwd: this.root, stdio: QUIET }).toString();
		} catch {
			throw new Error(`${collection}/${id}: no content at ${hash} for ${relPath} — nothing was reverted.`);
		}
		const current = fs.readFileSync(file, 'utf8');
		if (current === previousContent) return { id, reverted: false };
		// parse + validate the historical content before it touches disk
		const tmpFields = parseRecordText(previousContent, d, bodyField(d));
		// Snapshot BEFORE validate(), which qualifies bare refs in place. The mirror pass has to see
		// the record as the restored BYTES spell it — revert writes historical content verbatim, which
		// is the whole point of a revert — because `check` re-reads that file and expects a mirror only
		// for a ref it can parse. Qualifying `after` here would attach a mirror check then calls stale.
		const restored = { ...tmpFields };
		this.validate(d, tmpFields);
		return this.withWriteLock(() => {
			this._idsCache.delete(collection); // every mutation drops the memo — cleared even if the commit rolls back
			atomicWrite(file, previousContent);
			// revert is SET-shaped — it changes the owner's foreign key — so the mirrors move with it.
			// Skipping this left BOTH targets stale: the restored one never got its link back, and the
			// abandoned one kept a link the owner no longer claims. Same ordering as `add`, see there.
			let mirrors;
			try {
				mirrors = this.applyMirrorEdits(d, id, currentFields, restored);
			} catch (e) {
				atomicWrite(file, current);
				throw e;
			}
			this.commit([file, ...mirrors.files], `dreamteamer: ${collection} revert ${id} to ${String(hash).slice(0, 7)}`, () => {
				mirrors.undo();
				atomicWrite(file, current);
			}, d.storage.repo ?? '.');
			return { id, reverted: true, hash };
		});
	}

	// ---- validation (hard) ---------------------------------------------------

	validate(d, fields, { skipRefs = false } = {}) {
		// hard at the tools includes UNKNOWN fields: a typo'd key must never land on disk
		const unknown = unknownFields(d.schema, fields);
		if (unknown.length) throw new Error(`unknown field(s) for this collection: ${unknown.join(', ')} — nothing was written.`);
		// BEFORE ajv, and deliberately inside validate() rather than in each verb: this is the one
		// choke point add/set/revert all pass through, so `--starts "2026-07-28 12:00"` from a CLI
		// session and a `datetime-local` widget's `2026-07-28T12:00` reach disk as the same
		// canonical, offset-carrying value. ajv's `date-time` accepts exactly one spelling; without
		// this every human-shaped input is a validation error (see src/temporal.js).
		normalizeRecord(d.schema, fields);
		// qualifyBareRefs must ALSO run before ajv.compile(d.schema) below, for the same "one choke
		// point" reason but a different consequence: `validate(fields)` is what triggers useDefaults,
		// materializing any schema `default:` onto `fields` for the first time — a bare value sitting
		// in a single-target ref field's `default:` is never seen by qualifyBareRefs and would reach
		// checkRefs unqualified, failing as malformed rather than as the dangling reference it should
		// read as. In practice no shipped descriptor defaults a ref field, so this is latent, not hit.
		this.qualifyBareRefs(d, fields);
		const validate = this.ajv.compile(d.schema); // useDefaults mutates: defaults materialize
		if (!validate(fields)) {
			const msgs = validate.errors.map((e) => '  ' + fmtAjvError(e, fields));
			// The remedy line, when the cause is a generated mirror — see mirrorRemedy below.
			const remedy = mirrorRemedy(d, validate.errors.map((e) => e.instancePath.split('/')[1]));
			throw new Error(`validation failed:\n${msgs.join('\n')}${remedy}\nnothing was written.`);
		}
		if (!skipRefs) this.checkRefs(d, fields);
		return fields;
	}

	// Bare ids are accepted on INPUT for a field whose target set has exactly one member, and
	// qualified HERE — the same choke point that canonicalizes datetimes (normalizeRecord), for the
	// same reason: add/set reach disk through validate(), so the file always carries the one
	// canonical spelling. The deliberate exception is `revert`: it restores committed historical
	// BYTES verbatim (that is the whole point of a revert), calling validate() only to prove the
	// historical content still parses — never on the text that actually reaches atomicWrite. So a
	// bare ref that was committed past this choke point (hand-edited, or written by an older engine)
	// stays bare when reverted TO; `check` is what flags it, not this method. Union and '*' fields
	// never qualify: the prefix is the only type information those values carry. A value that
	// already parses as a ref is never rewritten — so a qualified-but-wrong id fails downstream as a
	// precise dangling reference, not as malformed syntax. Known limit: a slash-carrying bare id
	// (path-shaped ids) parses as a ref and is not qualified; the checkRefs error then names the
	// misread collection.
	qualifyBareRefs(d, fields) {
		for (const [key, s] of Object.entries(d.schema.properties ?? {})) {
			const targets = refTargetsOf(s);
			if (!targets || targets === '*' || targets.length !== 1) continue;
			const raw = fields[key];
			if (raw == null) continue;
			const qualify = (v) =>
				typeof v === 'string' && v !== '' && !v.startsWith('@') && !parseRef(v, this.namespaces)
					? `${targets[0]}/${v}`
					: v;
			fields[key] = Array.isArray(raw) ? raw.map(qualify) : qualify(raw);
		}
	}

	checkRefs(d, fields, prefix = []) {
		for (const [key, s] of Object.entries(d.schema.properties ?? {})) {
			const targets = refTargetsOf(s);
			if (!targets) continue;
			const raw = fields[key];
			if (raw == null) continue;
			for (const value of Array.isArray(raw) ? raw : [raw]) {
				if (typeof value !== 'string' || value.startsWith('@')) continue;
				// ONE parser for the collection/id boundary, shared with `check` and the extension —
				// a namespace that meant one thing on write and another on read would be worse than
				// no namespaces at all.
				const parsed = parseRef(value, this.namespaces);
				if (!parsed) throw new Error(`${key}: reference "${value}" is not <collection>/<id> — nothing was written.${mirrorRemedy(d, [key])}`);
				const { collection: coll, id } = parsed;
				if (targets !== '*' && !targets.includes(coll)) {
					const want = targets.length === 1 ? `collection "${targets[0]}"` : `one of: ${targets.join(', ')}`;
					throw new Error(`${key}: reference "${value}" must target ${want} — nothing was written.`);
				}
				if (!this.descriptors.has(coll)) throw new Error(`${key}: reference "${value}" targets unknown collection "${coll}" — nothing was written.`);
				if (!this.ids(coll).has(id)) throw new Error(`${key}: dangling reference "${value}" — no such record. nothing was written.${mirrorRemedy(d, [key])}`);
			}
		}
	}

	// ---- verbs -----------------------------------------------------------------

	add(collection, fields, { id: explicitId } = {}) {
		const d = this.writableDescriptor(collection);
		// before validate: a mirror value is refused on its own terms, not as a schema error
		this.refuseMirrorWrites(collection, null, Object.keys(fields));
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
			// OWNER FIRST, then the mirrors, then undo the owner if they refuse. The order matters: the
			// mirror pass reads targets through `ids()`, and a relation whose target IS this collection
			// (a record linking to its own kind) has to be able to see the record it is attaching. The
			// alternative — a dry pass that computes the edits without writing them — is the same loop
			// twice to save one `rmSync`, and two copies of it is how the two would drift apart.
			let mirrors;
			try {
				mirrors = this.applyMirrorEdits(d, id, null, fields);
			} catch (e) {
				fs.rmSync(file, { force: true });
				pruneEmptyDirs(path.dirname(file), this.dir(d));
				// ⚠ AND THE MEMO, or the removal is only half done. applyMirrorEdits reads targets through
				// `ids()`, so a relation whose target is this same collection re-cached it WITH the record
				// just written — and the memo key (HEAD + the collection's TOP directory mtime) does not
				// move for a record created and removed inside an existing sub-directory. This Store then
				// lists an id that is not on disk, and the next write's checkRefs accepts a reference to
				// it: a verb reporting success and landing a dangling ref.
				this._idsCache.delete(collection);
				throw e; // applyMirrorEdits already undid its own partial work — "nothing was written" is true again
			}
			// ONE commit, owner and mirrors together: a commit where only half a relation moved is a
			// history that never held a consistent workspace.
			this.commit([file, ...mirrors.files], `dreamteamer: ${collection} add ${id}`, () => {
				mirrors.undo();
				fs.rmSync(file, { force: true });
				pruneEmptyDirs(path.dirname(file), this.dir(d));
				this._idsCache.delete(collection); // same phantom as the catch above — see the note there
			}, d.storage.repo ?? '.');
			return { id, file };
		});
	}

	/** Import a file AS a record. There are no fields to validate and nothing to serialize, which is
	 *  why this is a sibling of add() rather than a branch inside it — the two share their last three
	 *  lines and nothing else. */
	addFile(collection, id, srcPath, { force = false } = {}) {
		const d = this.writableDescriptor(collection);
		if ((d.storage.codec ?? 'md') !== 'file') throw new Error(`"${collection}" is not a \`codec: file\` collection — add its records with --<field> values, not --from`);
		assertSafeId(id);
		if (d.id?.pattern && !patternRe(d.id.pattern).test(id)) {
			throw new Error(`id "${id}" does not match pattern ${d.id.pattern} — nothing was written.`);
		}
		const ext = path.extname(srcPath).slice(1).toLowerCase();
		if (!ext) throw new Error(`${srcPath} has no extension — a file record is named by one. Nothing was written.`);
		const allowed = d.storage.extensions;
		if (allowed && !allowed.includes(ext)) throw new Error(`"${collection}" does not accept .${ext} — its declared extensions are ${allowed.join(', ')}. Nothing was written.`);
		const size = fs.statSync(srcPath).size;
		const max = d.storage.max_bytes ?? MAX_RECORD_BYTES;
		if (size > max) throw new Error(`${srcPath} is ${size} bytes, over "${collection}"'s max_bytes of ${max} — a record is a small file. Nothing was written.`);
		const existing = this.ids(collection).get(id);
		if (existing && !force) throw new Error(`${collection}/${id} already exists — pass --force to replace it. Nothing was written.`);
		const file = this.filePath(d, id, ext);
		return this.withWriteLock(() => {
			this._idsCache.delete(collection);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			// A replacement whose extension changed would otherwise leave its predecessor behind, and
			// two files under one id is the ambiguity `check` reports. One id is one file.
			const stale = existing && existing !== file ? existing : null;
			const restore = snapshot([file, ...(stale ? [stale] : [])]);
			if (stale) fs.rmSync(stale, { force: true });
			fs.copyFileSync(srcPath, file);
			this.commit([file, ...(stale ? [stale] : [])], `dreamteamer: ${collection} add ${id}`, restore, d.storage.repo ?? '.');
			return { id, file };
		});
	}

	set(collection, id, changes) {
		const d = this.writableDescriptor(collection);
		this.refuseMirrorWrites(collection, id, Object.keys(changes));
		if ((d.storage.codec ?? 'md') === 'file') {
			throw new Error(`${collection}/${id} is a file record — its fields are derived from the file, so there is nothing to set. Replace it with \`dreamteamer add ${collection} ${id} --from <path> --force\`.`);
		}
		const { fields, file } = this.read(collection, id);
		const previous = fs.readFileSync(file, 'utf8');
		const next = { ...fields, ...changes };
		for (const [k, v] of Object.entries(changes)) if (v === null || v === '') delete next[k];
		this.validate(d, next);
		return this.withWriteLock(() => {
			this._idsCache.delete(collection);
			atomicWrite(file, serialize(d, next));
			// `fields` is the record as it was ON DISK and `next` as it will be, which is exactly the
			// before/after pair a mirror edit is: an FK that moved detaches from the old target and
			// attaches to the new one, in this same write. Same ordering as `add` — see the note there.
			let mirrors;
			try {
				mirrors = this.applyMirrorEdits(d, id, fields, next);
			} catch (e) {
				atomicWrite(file, previous);
				throw e;
			}
			this.commit([file, ...mirrors.files], `dreamteamer: ${collection} set ${id}`, () => {
				mirrors.undo();
				atomicWrite(file, previous);
			}, d.storage.repo ?? '.');
			return { id, file };
		});
	}

	/** Removal, against relations. `rm`'s guard is a TEXT SCAN over every record file — any file whose
	 *  bytes contain `<collection>/<id>` refuses the removal — and that was exactly right while every
	 *  inbound reference was somebody's hand-written data. It stopped being right the day the engine
	 *  started writing references of its own: the scan cannot tell a mirror it wrote from a value a
	 *  human typed, so it refused on the strength of its own bookkeeping and left `--force` — which
	 *  removes the record AND leaves the mirror pointing at nothing — as the only way through.
	 *
	 *  So inbound references split three ways, and only the third refuses:
	 *
	 *  MINE — the mirror entries this record's own FKs put on their targets. Detached here, through the
	 *  SAME pass add/set/revert use: `applyMirrorEdits(d, id, fields, null)` is precisely "this owner
	 *  now claims nothing", so there is one implementation of what a detach means, not two.
	 *
	 *  THEIRS, UNDER A RULE — an owner's FK pointing AT this record where the relation declares
	 *  `x-on-delete: set-null`. The schema author has already said what should happen; do it, in this
	 *  same commit.
	 *
	 *  THEIRS — everything else: `x-on-delete: restrict` (the default), and every prose or unmodelled
	 *  reference the scan finds. Still refused, still escapable with `--force`, which still reports how
	 *  many references it left dangling.
	 */
	rm(collection, id, { force = false } = {}) {
		const d = this.writableDescriptor(collection);
		const self = `${collection}/${id}`;
		// the existence check, and the FKs whose mirrors are detached below. Qualified on a COPY for the
		// same reason applyMirrorEdits qualifies `before`: a hand-edited or pre-namespace record can
		// hold `standup` where the engine writes `meetings/standup`, and a raw string compare misses it.
		const own = { ...this.read(collection, id).fields };
		this.qualifyBareRefs(d, own);
		const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
		// `bare` is whether this field's target set has exactly one member — the only case where
		// qualifyBareRefs would have expanded an unqualified value, so the only case where an
		// unqualified value on disk can be assumed to mean this collection.
		const isSelf = (v, bare) => {
			if (typeof v !== 'string') return false;
			const p = parseRef(v, this.namespaces);
			return p ? `${p.collection}/${p.id}` === self : bare && `${collection}/${v}` === self;
		};

		// ---- who points AT this record, and under what rule -------------------------------
		const setNullEdits = [];
		const restrictHits = [];
		for (const rel of this.relations()) {
			if (rel.target !== collection) continue;
			const targets = refTargetsOf(this.descriptor(rel.owner).schema?.properties?.[rel.field]);
			const bare = Array.isArray(targets) && targets.length === 1;
			// An owner the store cannot REWRITE cannot be set to null — and the honest fallback is
			// `restrict`, not silence: refusing is a sentence someone can act on, a skipped set-null is a
			// dangling reference from a verb that reported success.
			const clearable = rel.onDelete === 'set-null' && this.canRewrite(rel.owner);
			for (const { id: oid, file, fields: of } of this.readAll(rel.owner)) {
				if (!toArr(of[rel.field]).some((v) => isSelf(v, bare))) continue;
				if (clearable) setNullEdits.push({ rel, oid, file, of, bare });
				else restrictHits.push({ ref: `${rel.owner}/${oid}`, field: rel.field, file: path.relative(this.root, file) });
			}
		}

		// ---- what the text scan finds that is NOT the engine's own bookkeeping -------------
		// The scan is per FILE, and one file can name this record TWICE — a mirror the engine wrote, and
		// a wikilink somebody typed in the same record's body. So excluding a file WHOLESALE is wrong:
		// it drops the prose reference along with the managed one, and `check` reads frontmatter and
		// never prose, so the survivor dangles in silence. A file is excluded only when the edits below
		// account for every occurrence in it.
		//
		// Paths come through `ids()` so a planned path is the exact file the mirror pass rewrites — a
		// folder-shape record's ENTRY file, not its folder — which is also the shape findInboundRefs
		// reports. A target the mirror pass would bail on (`codec: file`, runtime-based) never received
		// a mirror, so nothing is planned there and a hit in it is real.
		const planned = new Map(); // workspace-relative path -> occurrences of `self` this write removes
		const plan = (file, n) => { const k = path.relative(this.root, file); planned.set(k, (planned.get(k) ?? 0) + n); };
		const memoized = new Set([collection]); // every collection whose id index this write invalidates
		for (const rel of this.relations()) {
			if (rel.owner !== collection || !this.canRewrite(rel.target)) continue;
			memoized.add(rel.target);
			for (const v of toArr(own[rel.field])) {
				const p = parseRef(v, this.namespaces);
				if (!p || p.collection !== rel.target) continue; // malformed, or another union member
				const f = this.ids(rel.target).get(p.id);
				if (f) plan(f, 1); // the one mirror entry naming this record, which the detach removes
			}
		}
		// LITERALLY, not semantically. The two numbers compared below are counted in different places —
		// this one off parsed FIELDS, `occurrences` off the file's raw BYTES — so they have to be
		// counted in the same UNIT, and the unit `occurrences` can see is "the fully-qualified string
		// `self`, present in the text". A single-target FK is legally stored BARE (`meetings: [one]` in
		// a hand-authored record: the store qualifies on write, but only through its own write path),
		// and `isSelf` matches that by design — crediting it here would claim a removal that deletes no
		// text, and the slack would swallow a real, separate wikilink in the same record: rm green, link
		// dangling, `check` silent about it because it reads frontmatter and never prose. A bare value
		// is invisible to the scan on both sides, which is the consistent answer: it contributes 0 here
		// and 0 there, and a record holding ONLY a bare FK is never named by the scan at all.
		for (const { rel, file, of } of setNullEdits) {
			memoized.add(rel.owner);
			plan(file, toArr(of[rel.field]).filter((v) => v === self).length);
		}
		const occurrences = (f) => (fs.readFileSync(path.join(this.root, f), 'utf8').match(this.refRegex(self)) ?? []).length;
		const inbound = this.findInboundRefs(self).filter((f) => !planned.has(f) || occurrences(f) > planned.get(f));
		// A restrict hit the scan already named is ONE reference described twice — keep the scan's
		// shape, which is what this sentence has always said. What the scan misses (a bare FK, or an
		// owner file excluded because it also holds a mirror of ours) is named as record + field.
		const extraRestrict = restrictHits.filter((h) => !inbound.includes(h.file));
		if ((inbound.length || extraRestrict.length) && !force) {
			const all = [...inbound, ...extraRestrict.map((h) => `${h.file} (${h.ref}.${h.field})`)];
			throw new Error(`${self} is referenced by:\n${all.map((f) => `  ${f}`).join('\n')}\nfix the references or pass --force. nothing was removed.`);
		}

		const unit = this.recordRoot(d, id); // folder-shape: the whole folder goes, not just the entry file
		// snapshot BEFORE the delete, or there is nothing left to read
		const restore = snapshot([unit]);
		// ⚠ THE MEMO, on the way in AND on every way back out. `ids()` keys its cache on HEAD plus the
		// collection's TOP directory mtime, neither of which moves for a record inside an existing
		// sub-directory — so an entry populated mid-write survives a rollback, and this Store then lists
		// an id that is not on disk (or omits one that is) for the rest of the process.
		const dropMemos = () => { for (const c of memoized) this._idsCache.delete(c); };
		return this.withWriteLock(() => {
			dropMemos();
			// MIRRORS FIRST, then the owners, then the delete. The mirror pass reads its targets through
			// `ids()`, and a self-referencing relation has to still see the record it is detaching from.
			const mirrors = this.applyMirrorEdits(d, id, own, null);
			const nullFiles = [];
			const nullUndos = [];
			// ONE rollback for all three mutations, used by the catch below AND handed to `commit`.
			// Order is reverse-chronological, because one file can be written twice (a mirror detach and
			// then an FK clear) and undoing the earlier write first would leave the later one standing —
			// except `restore`, which goes LAST because its snapshot of the removed record predates
			// everything, and so wins over a self-referencing edit to that same file. A COPY before
			// reversing, exactly as applyMirrorEdits does: `undo` may be called twice.
			const rollback = () => {
				for (const u of [...nullUndos].reverse()) u();
				mirrors.undo();
				restore();
				dropMemos();
			};
			try {
				for (const { rel, oid, file, bare } of setNullEdits) {
					// re-read INSIDE the lock: the mirror pass above may have just rewritten this very file
					// (two collections can point at each other), and `previous` has to be what is on disk
					// NOW or the undo below would resurrect a mirror that was correctly detached.
					const { fields: cur, descriptor: od } = this.read(rel.owner, oid);
					const previous = fs.readFileSync(file, 'utf8');
					if (Array.isArray(cur[rel.field])) {
						cur[rel.field] = cur[rel.field].filter((v) => !isSelf(v, bare));
						// the last element takes the KEY with it — `[]` is derived state leaking into a source
						if (!cur[rel.field].length) delete cur[rel.field];
					} else {
						delete cur[rel.field]; // `field: null` is not a cleared reference, it is a type error
					}
					atomicWrite(file, serialize(od, cur));
					this._idsCache.delete(rel.owner);
					nullFiles.push(file);
					nullUndos.push(() => atomicWrite(file, previous));
				}
				// ⚠ THE DELETE IS INSIDE THE TRY, and it has to be. It used to be rm's FIRST mutation, so a
				// failing unlink left the tree untouched; it is now the LAST of three, and outside the
				// rollback an EACCES here (a read-only mount, `chflags uchg`, a folder-shape record raced
				// by another writer) left the record in place with a mirror already detached and an FK
				// already cleared — two stale records behind a verb that threw.
				fs.rmSync(unit, { recursive: true });
			} catch (e) {
				rollback();
				throw e; // …and now "nothing was removed" is true of everything, not just the record
			}
			// ONE commit, the record and every reference the engine moved with it: a commit where the
			// target is gone but its owners still name it is a history that never held a consistent
			// workspace.
			this.commit([unit, ...mirrors.files, ...nullFiles], `dreamteamer: ${collection} rm ${id}`, rollback, d.storage.repo ?? '.');
			return { id, inboundIgnored: force ? inbound.length + extraRestrict.length : 0 };
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
			// Snapshot the referencing files BEFORE rewriteRefs edits them — its `touched` list
			// only exists after the damage is done. findInboundRefs returns paths relative to
			// this.root; snapshot() needs absolute paths.
			const refFiles = this.findInboundRefs(`${collection}/${oldId}`).map((f) => path.join(this.root, f));
			const restoreTouched = snapshot(refFiles);
			// rewrite inbound references (frontmatter/structured always; prose only via wikilinks)
			const { touched, rewrites, skipped } = this.rewriteRefs(`${collection}/${oldId}`, `${collection}/${newId}`);
			this.commit([oldUnit, newUnit, ...touched], `dreamteamer: ${collection} rename ${oldId} → ${newId}`, () => {
				fs.mkdirSync(path.dirname(oldUnit), { recursive: true });
				fs.renameSync(newUnit, oldUnit);
				pruneEmptyDirs(path.dirname(newUnit), this.dir(d));
				restoreTouched();
			}, d.storage.repo ?? '.');
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

	// ⚠ EACH FILE EXACTLY ONCE. The `modules` collection's storage.path is `modules` and
	// `sourceRoots()` includes the workspace root, so walking it RE-YIELDS every module source that
	// its own kind's walk already produced — 173 files in one real vault, every module source
	// among them.
	//
	// That was harmless while every rewrite was idempotent, and stopped being harmless the day
	// namespaces arrived: replacing `draft-docs/x` with `rnd/draft-docs/x` is NOT idempotent,
	// because the result still contains the pattern. A second pass wrote
	// `data/rnd/rnd/draft-docs/x` into module-source comments during a real migration. Dedupe HERE
	// rather than making each caller idempotent — `findInboundRefs` is a caller too, and its counts
	// were quietly doubled by the same walk.
	*recordFiles() {
		const seen = new Set();
		for (const d of this.descriptors.values()) {
			// for runtime-based collections, inbound-ref surgery targets SOURCES, not the runtime
			const roots = d.storage.base === 'runtime' ? this.sourceRoots() : [this.root];
			for (const srcRoot of roots) {
				const dir = path.join(srcRoot, d.storage.path);
				if (!fs.existsSync(dir)) continue;
				for (const f of walk(dir)) {
					const key = path.resolve(f);
					if (seen.has(key)) continue;
					seen.add(key);
					yield f;
				}
			}
		}
	}

	// every compiled module (review finding 10: this layer never learned decision 24 — rename
	// silently skipped git_modules sources), read off the manifest rather than by re-discovering
	// modules, which is what used to make the store import the compiler. See runtime.js.
	sourceRoots() {
		return compiledSourceRoots(this.root);
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

	/** Persist, or don't — `auto-commit` decides. The files are already on disk in both cases;
	 *  this only chooses whether they are published now or by a later `dt commit`.
	 *  `repo` is the workspace-relative root of the git repo that owns them ('.' = workspace). */
	commit(files, subject, undo, repo = '.') {
		if (!this.autoCommit) return;
		const cwd = path.resolve(this.root, repo);
		const rel = files.map((f) => path.relative(cwd, f));
		try {
			// QUIET, per the rule at the top of this file: a failure we CATCH must not also print git's
			// own error. These three were the exception — a caught `git add` failure dumped git's raw
			// multi-line advice ("Another git process seems to be running…") on top of the clean message
			// this function throws, so the user read the scary one and not the accurate one.
			execFileSync('git', ['add', '--all', '--', ...rel], { cwd, stdio: QUIET });
			execFileSync('git', ['commit', '--quiet', '-m', subject, '--', ...rel], { cwd, stdio: QUIET });
		} catch (e) {
			try { execFileSync('git', ['reset', '--quiet', '--', ...rel], { cwd, stdio: QUIET }); } catch { /* nothing staged */ }
			if (undo) {
				try { undo(); } catch (u) {
					throw new Error(`git commit failed AND rollback failed (${u.message}) — inspect the working tree. original: ${e.message.split('\n')[0]}`);
				}
			}
			throw new Error(`git commit failed — the write was rolled back, nothing was changed. (${e.message.split('\n')[0]})`);
		}
	}
}

/**
 * The remedy line for a refusal whose cause is a GENERATED MIRROR — `dreamteamer relations rebuild
 * <collection>`, the same repair `check`'s staleness message names, and for the same reason: a
 * mirror's value is derived state the engine wrote, not the caller's to edit.
 *
 * Without it, a legacy duplicate in a mirror array made an ORDINARY write to an unrelated field on
 * the same record fail with somebody else's bookkeeping and no way out:
 *
 *   dt set meetings/kickoff name="Kickoff 2"
 *   ✖ validation failed:
 *       field recordings: [...,...] must NOT have duplicate items (items ## 1 and 0 are identical)
 *     nothing was written.
 *
 * The generated mirror carries `uniqueItems`, so a duplicate in one is never a value this engine
 * produced — it arrived by hand, or from a workspace written before the keyword existed. Naming the
 * one command that repairs it is the difference between a wall and a step.
 */
export function mirrorRemedy(d, fieldNames) {
	const mirrors = [...new Set(fieldNames)].filter((f) => {
		const p = f && d.schema?.properties?.[f];
		const h = (p?.items && typeof p.items === 'object') ? p.items : p;
		return h?.['x-inverse-of'] !== undefined;
	});
	if (!mirrors.length) return '';
	return `\n  ${mirrors.join(', ')}: a GENERATED mirror — its value is derived from the owning side, not yours to set. Repair it with: dreamteamer relations rebuild ${d.name}`;
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

function readPkg(root) {
	try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return {}; }
}

/** Byte snapshot of a set of files OR DIRECTORIES, and a restore closure. The undo mechanism
 *  schema-ops has used for source writes since it was written (schema-ops.js:20). Record writes used
 *  `git checkout HEAD -- <paths>` instead, which is only correct while HEAD is guaranteed to be
 *  the last good state — it is not, once writes stop committing, and it silently discarded
 *  uncommitted hand-edits even before that.
 *
 *  A DIRECTORY unit is snapshotted recursively. It used to be skipped with a comment arguing the case
 *  could not occur — the only folder-shape collection was `skills`, which is system-stored, so
 *  `writableDescriptor` refused before `rm` was reached. That reasoning was true and is the wrong kind
 *  of true: it depended on a fact about the CURRENT set of collections rather than on anything the code
 *  enforces, and `shape: folder` is an ordinary descriptor option any workspace can choose. The failure
 *  it left behind was silent and total — `rm` would delete the folder and the "restore" closure would
 *  do nothing, so a failed commit meant the record was simply gone. Twelve lines, no such hole. */
function snapshot(units) {
	const snaps = units.map((u) => {
		const existed = fs.existsSync(u);
		const isDir = existed && fs.statSync(u).isDirectory();
		return {
			u, existed, isDir,
			prev: existed && !isDir ? fs.readFileSync(u) : null,
			tree: isDir ? snapshotTree(u) : null,
		};
	});
	return () => {
		for (const { u, prev, tree, existed, isDir } of snaps) {
			if (!existed) { fs.rmSync(u, { force: true, recursive: true }); continue; }
			if (isDir) {
				fs.rmSync(u, { force: true, recursive: true }); // partial state from a failed op
				fs.mkdirSync(u, { recursive: true });
				for (const [rel, bytes] of tree) {
					const dest = path.join(u, rel);
					fs.mkdirSync(path.dirname(dest), { recursive: true });
					fs.writeFileSync(dest, bytes);
				}
				continue;
			}
			if (prev !== null) { fs.mkdirSync(path.dirname(u), { recursive: true }); fs.writeFileSync(u, prev); }
		}
	};
}

/** Every file under `dir` as [relative path, bytes] — the whole of a folder-shape record. */
function snapshotTree(dir) {
	const out = [];
	for (const file of walk(dir)) out.push([path.relative(dir, file), fs.readFileSync(file)]);
	return out;
}
