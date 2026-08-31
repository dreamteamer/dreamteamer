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
import { refTargetsOf, refIsSoft } from './ref.js';
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
		this._head = undefined;     // memoized `git rev-parse HEAD` (see gitHead())
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

	/**
	 * Current HEAD, MEMOIZED PER STORE — one rev-parse per process rather than one per `ids()` call.
	 *
	 * ⚠ THE SUBPROCESS WAS THE COST OF THE CACHE, not of the walk it avoids. `ids()` asks this on
	 * EVERY call, hit or miss, and a `git rev-parse` is ~10ms of process spawn. Profiled on a
	 * 4,186-record workspace, a one-hop relational filter — which resolves one referenced record per
	 * row, and `read()` goes through the id index — spent 1,525ms of a 1,677ms command in this one
	 * method. Reproduced by `npm run perf` at 1/14 the scale: 300 rows, 301 spawns.
	 *
	 * ⚠ INVALIDATED BY WHATEVER RUNS `git commit` — `headMoved()`, below. It used to be dropped on
	 * the way OUT of every write lock instead, on the reasoning that everything able to move HEAD
	 * takes that lock. Two things were wrong with it. It was not TRUE — `commitPending` (`dt commit`,
	 * the verb that exists to move HEAD) takes no lock at all — and it was far too WIDE: with
	 * `auto-commit` off, which is the default, a record write moves nothing, and dropping the memo
	 * anyway cost the next `ids()` call a ~10ms subprocess to re-read a sha that had not changed. A
	 * run of 400 adds paid 400 of them: 9.9ms of the 10.7ms an add cost, measured on a generated
	 * collection. Naming the four commit sites is both narrower and more honest than naming the lock.
	 *
	 * What the memo does give up, stated rather than discovered: ANOTHER process committing during
	 * this one's lifetime no longer invalidates the id map. It costs nothing real — a commit does not
	 * change which record files exist, and one that does (a checkout, a revert) moves the collection
	 * directory's mtime, which is the other half of the key. A CLI process runs one verb, and the
	 * server already rebuilds its Store when the manifest moves.
	 */
	gitHead() {
		if (this._head === undefined) {
			try { this._head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.root, stdio: QUIET }).toString().trim(); }
			catch { this._head = 'no-git'; }
		}
		return this._head;
	}

	/** "This process just committed" — said by the four places that run `git commit` while a Store is
	 *  alive: `commit()` below, `commitPending`, and schema-ops' two source commits. See gitHead. */
	headMoved() { this._head = undefined; }

	ids(collection) {
		const d = this.descriptor(collection);
		const dir = this.dir(d);
		if (!fs.existsSync(dir)) return new Map();
		// memoized per collection, keyed by (HEAD sha, collection dir mtime): every tool
		// write commits (HEAD moves) and every store mutation clears its entry below;
		// direct top-level edits move the dir mtime. honest gap: a DEEP direct edit that
		// adds/removes a record without touching HEAD or the top dir mtime can serve one
		// stale read — acceptable, tool writes always commit and `check` covers hand edits.
		const key = this._idsKey(dir);
		const hit = this._idsCache.get(collection);
		if (hit?.key === key) return hit.ids;
		const ids = this._walkIds(d, dir);
		this._idsCache.set(collection, { key, ids });
		return ids;
	}

	/** The validity key `ids()` compares against, as its own method because `add` restates it AFTER
	 *  its write — the only way an index it just extended can still be accepted by the next call. */
	_idsKey(dir) { return `${this.gitHead()}:${fs.statSync(dir).mtimeMs}`; }

	/**
	 * The id index this add invalidated, handed back with ONE MORE ENTRY rather than thrown away.
	 *
	 * ⚠ A RUN OF ADDS WAS QUADRATIC, and the walk was the smaller half of it. `add` needs the ids
	 * that already exist in order to generate one that is unique, so every add called `ids()` — which
	 * asked `git rev-parse HEAD` for its key and then re-walked the collection from disk, because the
	 * previous add had deleted the very memo it was rebuilding. Measured on a generated 400-record
	 * collection: 10.7 ms/rec, of which 9.9 ms was the subprocess (see gitHead) and 0.68 ms the
	 * walk — and the walk is the term that GROWS. An add with an explicit id, which calls neither,
	 * costs 0.18 ms. After both: 0.57 ms, one subprocess for the whole run.
	 *
	 * The entry is INSERTED IN WALK ORDER, never appended. `ids()` iteration order is what `dt list`
	 * prints when nobody passes `--sort`, so an index that ordered records differently from a cold
	 * rebuild would make that order depend on how many writes the process had done first.
	 *
	 * The honest gap it adds, beside the two `ids()` already states: the key is stated from a stat
	 * taken just AFTER this write, so a record another process dropped into the same directory in
	 * that window goes unnoticed until something else moves the mtime. Same shape and same size as
	 * the cross-process gap the memo already accepts.
	 */
	_indexAdd(collection, memo, id, file) {
		// nothing was memoized before this write, or the mirror pass has already rebuilt it cold from
		// disk — either way a walk is the current answer and this has nothing to add to it.
		if (!memo || this._idsCache.has(collection)) return;
		const dir = this.dir(this.descriptor(collection));
		const ids = new Map();
		let placed = false;
		for (const [k, v] of memo.ids) {
			if (!placed && beforeInWalk(path.relative(dir, file), path.relative(dir, v))) { ids.set(id, file); placed = true; }
			ids.set(k, v);
		}
		if (!placed) ids.set(id, file);
		this._idsCache.set(collection, { key: this._idsKey(dir), ids });
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
				// A SOFT reference resolves if the target is present and is ignored if it is absent
				// (see ref.js). Honoured HERE as well as in `check` on purpose: the two paths reaching
				// different verdicts on identical bytes is the divergence this validator was aligned
				// with `check` to prevent in the first place.
				const soft = refIsSoft(s);
				if (!this.descriptors.has(coll)) {
					if (soft) continue;
					throw new Error(`${key}: reference "${value}" targets unknown collection "${coll}" — nothing was written.`);
				}
				if (!this.ids(coll).has(id) && !soft) throw new Error(`${key}: dangling reference "${value}" — no such record. nothing was written.${mirrorRemedy(d, [key])}`);
			}
		}
	}

	// ---- verbs -----------------------------------------------------------------

	add(collection, fields, { id: explicitId } = {}) {
		const d = this.writableDescriptor(collection);
		// before validate: a mirror value is refused on its own terms, not as a schema error
		this.refuseMirrorWrites(collection, null, Object.keys(fields));
		this.validate(d, fields);
		// the KEYS, not a copy of them: `generateId` iterates this once and only for a `{{ seq }}`
		// template, so materializing the whole id list was an O(N) allocation per add that almost
		// every collection threw away unread.
		const id = explicitId ?? generateId(d.id?.generate ?? '{{ name | slug }}', fields, this.ids(collection).keys());
		if (d.id?.pattern && !patternRe(d.id.pattern).test(id)) {
			throw new Error(`id "${id}" does not match pattern ${d.id.pattern} — nothing was written.`);
		}
		const file = this.filePath(d, id);
		if (fs.existsSync(file)) throw new Error(`${collection}/${id} already exists — nothing was written.`);
		return this.withWriteLock(() => {
			// captured before the invalidation and handed back, one entry richer, on the success path
			// below — see _indexAdd for why an add that throws it away is the expensive shape.
			const memo = this._idsCache.get(collection);
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
			// LAST, after the commit: the key it is re-stated under carries the sha, and `commit` moves it
			this._indexAdd(collection, memo, id, file);
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
			// rewrite inbound references (frontmatter/structured always; prose only via wikilinks). It
			// snapshots what it writes as it writes it — see rewriteRefs for why the caller cannot.
			const { touched, rewrites, skipped, ambiguous, restore } = this.rewriteRefs(`${collection}/${oldId}`, `${collection}/${newId}`);
			this.commit([oldUnit, newUnit, ...touched], `dreamteamer: ${collection} rename ${oldId} → ${newId}`, () => {
				fs.mkdirSync(path.dirname(oldUnit), { recursive: true });
				fs.renameSync(newUnit, oldUnit);
				pruneEmptyDirs(path.dirname(newUnit), this.dir(d));
				restore();
			}, d.storage.repo ?? '.');
			// each entry names the PAIR it came from, because a batch has more than one — see rewriteRefsBatch
			for (const s of skipped) {
				console.warn(`⚠ ${path.relative(this.root, s.file)}: ${s.count} raw-prose occurrence(s) of ${s.oldRef} left untouched — only [[wikilinks]] are maintained in bodies (decision 7)`);
			}
			for (const a of ambiguous) {
				console.warn(`⚠ ${path.relative(this.root, a.file)}: ${a.count} bare [[${a.base}]] wikilink(s) left untouched — ${a.claimants.join(', ')} also ends in "${a.base}", so nothing here can tell which record the link means. Rewrite by hand, or spell it [[${a.newRef}]].`);
			}
			return { id: newId, rewrites, touched: touched.length, skipped: skipped.length, ambiguous: ambiguous.length };
		});
	}

	// exact-ref matching with a boundary so contacts/jane never matches contacts/jane-doe
	refRegex(ref) {
		return new RegExp(`${escapeRe(ref)}(?![\\w/-])`, 'g');
	}

	/** Every record in the workspace whose id ENDS in `base`, as `<collection>/<id>`. What decides
	 *  whether a bare `[[base]]` wikilink names one thing — see rewriteRefs. Asked of the id index of
	 *  every collection rather than of a text scan, because the question is about records, not files. */
	basenameOwners(base) {
		const out = [];
		for (const name of this.descriptors.keys()) {
			for (const id of this.ids(name).keys()) if (id.split('/').pop() === base) out.push(`${name}/${id}`);
		}
		return out;
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

	/**
	 * decision 7 (un-parked): structured surfaces (frontmatter, yaml/json records) rewrite
	 * unconditionally; PROSE bodies rewrite only inside `[[…]]` wikilinks — raw-text matching
	 * corrupted look-alike URLs (review finding 4). raw body occurrences are counted and reported,
	 * never touched.
	 *
	 * ⚠ A WIKILINK IS BARE MORE OFTEN THAN IT IS QUALIFIED. `[[ada]]` is what a person types and what
	 * every wikilink editor writes; `[[people/ada]]` is the disciplined spelling. Only the qualified
	 * form was followed, and the failure was SILENT in both directions — the link dangled, and the
	 * skipped-prose counter matched the qualified form too, so it was not even reported as skipped.
	 * "Wikilinks are maintained" was true of the shape nobody writes.
	 *
	 * So a rename that changes the BASENAME runs a second pass over bodies, and it refuses to guess:
	 * `[[ada]]` follows the rename only when `ada` is the basename of exactly one record in the whole
	 * workspace (`basenameOwners`, asked AFTER the move, so the renamed record is no longer among
	 * them). When something else claims it too the link is left exactly as it is and counted into
	 * `ambiguous`, which `rename` reports by file — an unfollowed link somebody knows about is a
	 * different thing from one nobody does. A rename that keeps the basename (`collections rename`,
	 * where only the collection moves) runs no bare pass at all: those links still name what they
	 * always named.
	 */
	rewriteRefs(oldRef, newRef) {
		return this.rewriteRefsBatch([[oldRef, newRef]]);
	}

	/**
	 * The same rewrite, for MANY old→new pairs at once: each record file is opened ONCE and every
	 * pair is applied to the bytes in hand, in the order given.
	 *
	 * ⚠ THIS IS THE WHOLE IMPLEMENTATION — `rewriteRefs` is the batch of one. A second single-pair
	 * copy of the rules above (prose scoping, the bare-basename ambiguity test, the boundary) is
	 * exactly the drift this method exists to avoid.
	 *
	 * ⚠ WHY A BATCH, MEASURED. `collections rename` called this once per record id, and walked every
	 * record file a second time before that to snapshot them for rollback: `npm run perf --
	 * --records=400 --filler=100` cost 410,678 reads and 6.39s for 400 ids over 504 files — ~800
	 * passes over the same bytes to rewrite 4 references. One pass answers every pair: 1,075 and
	 * 0.16s.
	 *
	 * The pre-filter is a NEGATIVE one and nothing else: a file whose text lacks the prefix every
	 * needle starts with cannot contain any of them, so it is skipped unread-twice — but a file that
	 * has it is still matched by the boundary-aware regexes below, never by the prefix. A prefix
	 * match would follow `data/tasks/` in a path and `…/ledger/alpha-x` in a URL.
	 *
	 * ⚠ THE SNAPSHOT IS TAKEN HERE, not by the caller. `rename` used to snapshot what
	 * `findInboundRefs` reported — the QUALIFIED occurrences — which is not the set this method
	 * writes: a body holding only `[[ada]]` is rewritten below and was in nobody's rollback. The
	 * bytes are already in hand at the point of the write, so this is the one place that cannot be
	 * out of step with it — and a failure part-way through undoes what it already wrote before it
	 * throws, so a caller's own rollback never has to guess how far it got.
	 *
	 * `skipped` and `ambiguous` entries carry the pair that produced them (`oldRef`/`newRef`, plus
	 * the `base` and its `claimants`), because in a batch there is no single one to imply.
	 */
	rewriteRefsBatch(pairs) {
		const plans = pairs.map(([oldRef, newRef]) => {
			const oldBase = oldRef.split('/').pop();
			const newBase = newRef.split('/').pop();
			const bareRe = oldBase === newBase ? null : new RegExp(`\\[\\[${escapeRe(oldBase)}(\\|[^\\]]*)?\\]\\]`, 'g');
			return {
				oldRef, newRef, newBase, base: oldBase, bareRe,
				refRe: this.refRegex(oldRef),
				wikiRe: new RegExp(`\\[\\[${escapeRe(oldRef)}(\\|[^\\]]*)?\\]\\]`, 'g'),
				// asked of the id index, not of a text scan — and only when a bare pass can happen at all
				claimants: bareRe ? this.basenameOwners(oldBase) : [],
			};
		});
		// a bare pass matches `[[base]]`, which does NOT contain the ref — so the basename is a needle too
		const probe = commonPrefix(plans.flatMap((p) => (p.bareRe ? [p.oldRef, p.base] : [p.oldRef])));

		const touched = [];
		const skipped = [];
		const ambiguous = [];
		const undos = [];
		let rewrites = 0;
		// a COPY before reversing, as applyMirrorEdits does: `restore` may be called twice
		const restore = () => { for (const u of [...undos].reverse()) u(); };
		try {
			for (const f of this.recordFiles()) {
				const text = fs.readFileSync(f, 'utf8');
				if (probe && !text.includes(probe)) continue;
				// prose scoping applies to EVERY .md — a frontmatter-less file is all body
				// (docs-audit catch: it used to fall through to raw replacement)
				const prose = f.endsWith('.md');
				const fm = prose ? /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/.exec(text) : null;
				let head = prose ? (fm ? fm[1] : '') : text;
				let body = prose ? (fm ? fm[2] : text) : '';
				let count = 0;
				for (const p of plans) {
					head = head.replace(p.refRe, () => (count++, p.newRef));
					if (!prose) continue;
					// the qualified pass FIRST: it turns `[[people/ada]]` into `[[people/ada-l]]`, which the
					// bare pattern cannot match either before or after, so the two never see each other's work
					body = body.replace(p.wikiRe, (_, label) => (count++, `[[${p.newRef}${label ?? ''}]]`));
					if (p.bareRe && !p.claimants.length) body = body.replace(p.bareRe, (_, label) => (count++, `[[${p.newBase}${label ?? ''}]]`));
					else if (p.bareRe) { const n = (body.match(p.bareRe) ?? []).length; if (n) ambiguous.push({ file: f, count: n, base: p.base, claimants: p.claimants, oldRef: p.oldRef, newRef: p.newRef }); }
					// counted on the body this pair leaves behind, so a later pair sees what an on-disk
					// pass would have seen — raw prose is reported, never rewritten (decision 7)
					const raw = (body.match(p.refRe) ?? []).length;
					if (raw) skipped.push({ file: f, count: raw, oldRef: p.oldRef, newRef: p.newRef });
				}
				if (count === 0) continue;
				rewrites += count;
				undos.push(() => atomicWrite(f, text));
				atomicWrite(f, head + body);
				touched.push(f);
			}
		} catch (e) {
			restore(); // "nothing was rewritten" stays true of a batch that died half way through it
			throw e;
		}
		return { touched, rewrites, skipped, ambiguous, restore };
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
		try {
			return fn();
		} finally {
			try { fs.rmdirSync(lock); } catch { /* already gone */ }
		}
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
		} finally {
			// ⚠ WHETHER IT LANDED OR NOT. The failure path resets the index and undoes the write, but a
			// commit that threw may still have created one — and a HEAD memo naming the previous sha
			// would keep serving id maps from before it. See gitHead.
			this.headMoved();
		}
	}
}

/** A literal, for a pattern built out of an id or a ref. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The longest prefix every needle shares, or '' if they share none. Used ONLY as a negative filter
 *  (see rewriteRefsBatch): anything containing a needle contains this, so anything without it
 *  contains no needle — and a hit means nothing at all. */
function commonPrefix(needles) {
	let p = needles[0] ?? '';
	for (const n of needles) {
		let i = 0;
		while (i < p.length && p[i] === n[i]) i++;
		p = p.slice(0, i);
		if (!p) break;
	}
	return p;
}

/** Is `a` yielded before `b` by `walk()`? It sorts each directory level and DESCENDS before it
 *  yields, so the order is a segment-wise compare of the relative paths and never a plain string
 *  one: `2026-01.entry.md` sorts before `2026/x.entry.md` as a string ('-' < '/') and after it in
 *  the walk, because readdir meets the directory `2026` first and empties it on the way past. */
function beforeInWalk(a, b) {
	const A = a.split(path.sep);
	const B = b.split(path.sep);
	for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) return A[i] < B[i];
	return A.length < B.length;
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
