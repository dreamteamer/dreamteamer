// dt commit — publish what is already on disk. Model: GIT IS THE JOURNAL. There is no pending
// file and no cursor; the set of things to commit is sampled from `git status` over the record
// directories of every collection, which means it cannot disagree with reality.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToRecord } from './events.js';
import { parseRecordText } from './records.js';
import { relationsOf } from './relations.js';
import { splitRef } from './ref.js';

// git calls whose failure we CATCH must not print git's own error: execFileSync forwards the
// child's stderr to ours unless told otherwise, so a handled "not a git repository" still
// reached the user's terminal. stdout stays piped because we read it.
const QUIET = ['ignore', 'pipe', 'ignore'];


const VERB = { A: 'add', M: 'set', D: 'rm', R: 'rename', '?': 'add' };

/** What the caller asked to publish. A target is EITHER a collection name or a `<collection>/<id>`
 *  reference — the same either-shape `move` and `commands` accept, and after 0.12.0 the shape every
 *  other verb's target has. Which one it is cannot be guessed from the string (an id may contain
 *  slashes and so may a namespaced collection name), so it is decided against the DECLARED
 *  collections: a key of `descriptors` is a collection, anything else goes to splitRef — which
 *  throws, naming the known collections, rather than letting a typo mean "no scope".
 *
 *  Returns `scope` (collections to sample, so the git pathspec stays as narrow as it was), `whole`
 *  (collections asked for entire) and `records` (ref → {collection, id}). */
function parseTargets(descriptors, only) {
	const scope = new Set();
	const whole = new Set();
	const records = new Map();
	for (const target of only) {
		if (descriptors.has(target)) { whole.add(target); scope.add(target); continue; }
		const { collection, id } = splitRef(descriptors, target);
		records.set(`${collection}/${id}`, { collection, id });
		scope.add(collection);
	}
	return { scoped: only.length > 0, scope: [...scope], whole, records };
}

const SIDES = ['targets', 'owners'];
const NO_EDGES = { targets: new Set(), owners: new Set() };

/** Relation FIELDS on `collection`, each tagged with which SIDE the record at the other end stands
 *  on and which collection it lives in. That side is the whole safety argument for the sweep below:
 *  a TARGET's mirror is bookkeeping the engine wrote BECAUSE OF this record's own write, so dragging
 *  any number of them into the commit is honest. An OWNER is somebody's record, whose existence this
 *  write does not imply — so dragging one in is rationed, and two is a refusal. */
function relationEdges(rels, collection) {
	const edges = [];
	for (const r of rels) {
		if (r.owner === collection) edges.push([r.field, 'targets', r.target]);
		if (r.target === collection) edges.push([r.mirror, 'owners', r.owner]);
	}
	return edges;
}

/** The refs a record names through its relation fields, split by side. */
function edgesOf(fields, edges) {
	const out = { targets: new Set(), owners: new Set() };
	for (const [field, side] of edges) for (const v of [].concat(fields?.[field] ?? [])) out[side].add(v);
	return out;
}

/** One dirty record's relation edges as git holds them AT HEAD and as they stand in the worktree,
 *  plus the HEAD bytes (which is how a rename is recognised below).
 *
 *  Neither version may throw. An unreadable or UNPARSEABLE one contributes no edges instead: a
 *  record hand-edited into broken frontmatter and published weeks ago must not take `dt commit`
 *  down — and it must not take it down only in the record-scoped form, which is the shape of bug
 *  nobody attributes correctly ("commit works, commit <record> dies with a bare YAML error"). */
function readState(store, rels, row) {
	const edges = row ? relationEdges(rels, row.collection) : [];
	if (!edges.length) return { row, was: NO_EDGES, now: NO_EDGES, headText: null };
	let headText = null;
	try { headText = execFileSync('git', ['show', `HEAD:${row.repoRel}`], { cwd: row.cwd, stdio: QUIET }).toString(); }
	catch { headText = null; } // untracked, or an empty repo: no pre-image, so no edges at HEAD
	let was = NO_EDGES;
	try { if (headText !== null) was = edgesOf(parseRecordText(headText, store.descriptors.get(row.collection)), edges); }
	catch { was = NO_EDGES; }
	let now = NO_EDGES;
	try { now = edgesOf(store.read(row.collection, row.id).fields, edges); }
	catch { now = NO_EDGES; } // a pending deletion, or unparseable on disk
	return { row, was, now, headText };
}

/** The refusal, and the reason it is a refusal rather than a choice: publishing the file anyway
 *  either steals the other session's record or leaves a HEAD that fails `dt check`. Name all three
 *  parties — without the FILE the reader cannot see why two unrelated records are in one sentence,
 *  and without the other records they cannot type the command that fixes it. */
function entangled(file, parties, command) {
	return new Error(`${file} holds relation changes from ${parties.join(' and ')}, and there is no commit that publishes one without the other. Name them together (dreamteamer commit ${command}) or wait for the other session to publish.`);
}

/** Every sampled row by reference, and its relation edges as they moved since HEAD.
 *
 *  Lazy and memoised, and that is a PERFORMANCE CONTRACT rather than a micro-optimisation: reading
 *  one git pre-image per SAMPLED row cost 3.19s against 0.10s on a 300-dirty-row collection. Only
 *  the records actually asked about are ever read — and a row in a collection with no relations at
 *  all costs nothing, because readState answers it without touching git. */
function edgeReader(store, rels, sampled) {
	const rows = new Map();
	for (const { cwd, rows: rs } of sampled) for (const r of rs) rows.set(`${r.collection}/${r.id}`, { ...r, cwd });
	const cache = new Map();
	const stateOf = (ref) => {
		if (!cache.has(ref)) cache.set(ref, readState(store, rels, rows.get(ref)));
		return cache.get(ref);
	};
	const moved = (ref, side) => {
		const { was, now } = stateOf(ref);
		return [...was[side]].filter((v) => !now[side].has(v)).concat([...now[side]].filter((v) => !was[side].has(v)));
	};
	return { rows, stateOf, moved };
}

/** Which dirty partners the named records DRAG INTO the same commit.
 *
 *  The rule is EDGE-CHANGE, not field membership: a partner joins only if the edge between it and a
 *  named record appeared, disappeared or moved since HEAD. A partner dirty for any other reason —
 *  another session's prose, another field, another session's edge — is left exactly as pending as it
 *  was found. The first cut swept every ref in the named record's relation fields and reintroduced
 *  precisely the theft this file exists to prevent (CLAUDE.md rule 6). */
function planSweep(targets, { rows, stateOf, moved }) {
	// `dt rename` leaves the old path DELETED and the new path UNTRACKED — neither staged, so git
	// reports no `R` (that only exists for a staged rename, which is why `fromRel` is null here) and
	// the two halves read as two unrelated records. They are ONE record: the id lives in the
	// FILENAME, so the new file's bytes ARE the old file's bytes at HEAD. That is git's own exact
	// rename heuristic, applied where git cannot see the pair. Getting it wrong means either leaving
	// half a rename at HEAD or refusing an ordinary rename as a concurrent-write conflict.
	const sameRecord = (oldRef, newRef) => {
		const o = stateOf(oldRef), n = stateOf(newRef);
		if (o.row?.verb !== 'rm' || n.row?.verb !== 'add' || o.row.collection !== n.row.collection) return false;
		try { return o.headText === fs.readFileSync(path.resolve(n.row.cwd, n.row.repoRel), 'utf8'); }
		catch { return false; }
	};
	const named = new Set([...targets.records.keys()].filter((ref) => rows.has(ref)));
	// A record's TARGETS are the partners its own write moved, so naming it asks for them. Its OWNERS
	// are not: a mirror is engine-owned state that ANOTHER session writes into, so an owner's edge
	// arriving in this file is that session's write, and it is inspected below rather than swept.
	const sweep = new Set();
	for (const ref of named) for (const t of moved(ref, 'targets')) if (rows.has(t)) sweep.add(t);
	// Every file this commit will carry — the named records AND the partners they drag in — is
	// published WHOLE, edge changes and all. So the same test applies to both: an edge change to a
	// record this commit does not account for belongs to somebody else, and there is no honest way to
	// publish around it. Restricting this to the swept partners left the theft alive on the owning
	// side — `dt commit <target>` published a concurrent session's new owner when the caller's own
	// change had not touched an edge at all.
	const queue = [...named, ...sweep];
	for (let i = 0; i < queue.length; i++) {
		const strangers = [];
		for (const side of SIDES) for (const v of moved(queue[i], side)) {
			if (!rows.has(v) || named.has(v) || sweep.has(v)) continue;
			// A row inside a collection asked for WHOLE is already in this commit — refusing over it
			// would refuse a commit that publishes it anyway.
			if (targets.whole.has(rows.get(v).collection)) continue;
			// …and the same record under its pre-rename id is not a second record at all.
			if ([...named].some((n) => sameRecord(v, n))) { sweep.add(v); queue.push(v); continue; }
			strangers.push(v);
		}
		if (!strangers.length) continue;
		const own = queue[i];
		const parties = [...named].filter((n) => n !== own).concat(strangers);
		throw entangled(stateOf(own).row.repoRel, parties, [...named, ...strangers].join(' '));
	}
	return sweep;
}

/** Dirty records this commit does NOT publish whose edge to one it DOES publish moved since HEAD —
 *  i.e. the other half of a pair, left behind.
 *
 *  `dt commit <collection>` publishes exactly that collection and nothing else, on purpose:
 *  narrowing it to whole pairs would drop rows the caller explicitly asked for, and widening it to
 *  the partner collection is the theft this file exists to prevent. So it goes on publishing half a
 *  pair — and HEAD then fails `dt check` until the other half lands. Naming the leftovers is what
 *  turns that from a silent red HEAD into one more command to run.
 *
 *  Same edge-change rule as the sweep, from the other end: a partner dirty for unrelated reasons is
 *  not named, because publishing this commit did not put it out of step with anything. */
function partnersLeftPending(reader, published) {
	const left = new Set();
	for (const ref of reader.rows.keys()) {
		if (published.has(ref)) continue;
		for (const side of SIDES) for (const v of reader.moved(ref, side)) if (published.has(v)) left.add(ref);
	}
	return [...left].sort();
}

/** Record directories to watch, grouped by owning repo. System-stored collections are excluded:
 *  they live in the gitignored runtime and their sources are module files — the same exclusion
 *  pathToRecord already applies. */
function scopeByRepo(descriptors, only) {
	const byRepo = new Map();
	for (const d of descriptors.values()) {
		const p = d.storage?.path;
		// `storage.base`, not a `system/` prefix: after the flatten a runtime collection's path is a
		// bare kind name (`skills`), so the old test admitted all seven — and this list becomes a
		// `git add` pathspec, which fails outright on a path the workspace root does not have.
		if (!p || d.storage.base === 'runtime') continue;
		if (only.length && !only.includes(d.name)) continue;
		const repo = d.storage.repo ?? '.';
		if (!byRepo.has(repo)) byRepo.set(repo, []);
		byRepo.get(repo).push(p);
	}
	return byRepo;
}

/** In-progress merge/rebase/cherry-pick makes a commit's meaning ambiguous. Ordinary dirtiness
 *  is NOT a refusal condition — committing dirty records is this verb's entire job. */
function inProgress(cwd) {
	let gitDir;
	try { gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, stdio: QUIET }).toString().trim(); }
	catch { return 'not a git repository'; }
	for (const [marker, label] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
		if (fs.existsSync(path.join(gitDir, marker))) return `a ${label} is in progress`;
	}
	return null;
}

/** A commit on a detached HEAD is reachable only by sha. Worth saying out loud before making one;
 *  not worth refusing over, since it is sometimes exactly what someone means to do. */
function detached(cwd) {
	try { return execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd, stdio: QUIET }).toString().trim() === ''; }
	catch { return true; }
}

/** Sample one repo: porcelain status over its record dirs → [{repoRel, collection, id, verb}].
 *  `git status` run in a module repo returns REPO-relative paths; pathToRecord takes
 *  WORKSPACE-relative ones, so every path is re-prefixed before matching. Skip this and every
 *  module-owned path maps to null — dt commit would commit nothing and report success. */
function sample(root, repo, dirs, descriptors) {
	const cwd = path.resolve(root, repo);
	const prefix = repo === '.' ? '' : `${repo}/`;
	const relDirs = dirs.map((d) => (prefix && d.startsWith(prefix) ? d.slice(prefix.length) : d));
	// `-uall` is load-bearing: by default porcelain COLLAPSES an untracked directory to a single
	// `?? data/notes/` entry, which maps to no record — so the first records of a brand-new
	// collection would be invisible and dt commit would report success having committed nothing.
	// QUIET: the caller (cli `status`) catches a failure here so it can still print the rest of the
	// report in a non-git folder — but git's own "fatal: not a git repository" was reaching the
	// terminal anyway, which made a handled case look like a crash.
	const out = execFileSync('git', ['status', '--porcelain', '-z', '-uall', '--', ...relDirs], { cwd, stdio: QUIET }).toString();
	const chunks = out.split('\0').filter((c) => c.length > 0);
	const rows = [];
	for (let i = 0; i < chunks.length; i++) {
		const status = chunks[i].slice(0, 2).trim()[0] ?? 'M';
		const repoRel = chunks[i].slice(3);
		// -z emits a rename/copy as TWO chunks: the new path carries the `XY ` prefix, the old
		// path follows BARE. Consume it here or the next iteration reads a path as a status code
		// — and worse, the old path never gets staged, so the commit keeps half a rename.
		const fromRel = (status === 'R' || status === 'C') ? chunks[++i] : null;
		const rec = pathToRecord(descriptors, prefix + repoRel);
		if (!rec) continue;
		rows.push({ repoRel, fromRel, ...rec, verb: VERB[status] ?? 'set' });
	}
	return { cwd, rows };
}

/** One subject for one repo's rows. The git status letter IS the verb, which is why a
 *  single-record commit keeps exactly the subject it had when writes committed themselves. */
export function composeSubject(rows) {
	if (rows.length === 1) return `dreamteamer: ${rows[0].collection} ${rows[0].verb} ${rows[0].id}`;
	const collections = [...new Set(rows.map((r) => r.collection))].sort();
	if (collections.length === 1) {
		const counts = {};
		for (const r of rows) counts[r.verb] = (counts[r.verb] ?? 0) + 1;
		const parts = Object.entries(counts).map(([v, n]) => `${n} ${v}`).join(', ');
		return `dreamteamer: ${collections[0]} ${rows.length} changes (${parts})`;
	}
	return `dreamteamer: ${rows.length} changes across ${collections.join(', ')}`;
}

/** A requested reference that matched no pending row is one of two very different things: a record
 *  that is already published (nothing to do, and fine) or a MISTYPED id — which must not pass as
 *  "nothing pending", the one report that looks like success. Only the store can tell them apart,
 *  and it is only asked in this branch: a pending DELETION matched a row above, so a record whose
 *  file is legitimately gone never reaches here. */
function assertResolvable(store, records, matched) {
	for (const [ref, { collection, id }] of records) {
		if (matched.has(ref) || store.ids(collection).has(id)) continue;
		throw new Error(`${ref}: no such record — nothing pending under that reference`);
	}
}

export function commitPending(store, { only = [], message, dryRun = false } = {}) {
	// Targets are resolved BEFORE anything is committed, so one bad target in a list of good ones
	// leaves the whole tree untouched rather than committing a prefix of what was asked for.
	const targets = parseTargets(store.descriptors, only);
	// A relational write dirties TWO records — the owner's foreign key and the target's generated
	// mirror. Auto-commit is off, so publishing one without the other leaves a HEAD that fails
	// `dt check`. ⚠ The partner collections must join `targets.scope` BEFORE scopeByRepo: scope IS the
	// git pathspec, so a collection missing from it is never sampled and nothing later can reach it.
	const rels = targets.scoped ? relationsOf(store.descriptors) : [];
	const partners = new Set();
	const hop = (c) => { for (const [, , partner] of relationEdges(rels, c)) partners.add(partner); };
	for (const [, { collection }] of targets.records) hop(collection);
	// ⚠ TWO HOPS for a named record, and the second one is the entanglement guard's eyesight. The
	// sweep drags a partner in WHOLE, edge changes and all — so a concurrent session's record on the
	// far side of that partner's OTHER edge has to be refused over. planSweep tests a stranger with
	// `rows.has(v)`, and rows exist only for a SAMPLED collection: at one hop that collection is
	// never sampled, the stranger is invisible, and the commit publishes the partner carrying a
	// reference to an unpublished record (dangling ref + stale mirror at HEAD). Two is sufficient
	// and three would be waste — the sweep only ever reaches DIRECT partners of a named record, so
	// nothing further out can end up inside the commit.
	for (const p of [...partners]) hop(p);
	// A whole-collection target drags nothing in, but its partners must still be SAMPLED or the
	// leftover warning below has no rows to find them in. One hop is all that reaches.
	for (const c of targets.whole) hop(c);
	for (const p of partners) targets.scope.push(p);
	const byRepo = scopeByRepo(store.descriptors, targets.scope);
	// ⚠ Sample every repo FIRST, then check the references, then plan, then commit. The
	// unknown-reference test below can only be answered once every repo has been sampled — a record
	// lives in exactly one repo, and which one is not known in advance — and the sweep needs every
	// repo's rows before it can tell a renamed record from a concurrent deletion.
	const sampled = [];
	for (const [repo, dirs] of byRepo) {
		const { cwd, rows } = sample(store.root, repo, dirs, store.descriptors);
		sampled.push({ repo, cwd, rows });
	}
	const matched = new Set();
	for (const { rows } of sampled) for (const r of rows) {
		const ref = `${r.collection}/${r.id}`;
		if (targets.records.has(ref)) matched.add(ref);
	}
	// Before the sweep, so a mistyped id is still answered as a mistyped id rather than as an empty
	// plan that looks like "nothing pending" — the one report that looks like success.
	assertResolvable(store, targets.records, matched);
	const reader = edgeReader(store, rels, sampled);
	const sweep = targets.scoped ? planSweep(targets, reader) : new Set();
	const results = [];
	for (const { repo, cwd, rows: all } of sampled) {
		// The SAMPLER is deliberately left alone — it is what makes a hand-edited record
		// indistinguishable from one the store wrote. Narrowing happens HERE, on the sampled rows, so
		// `dt commit <collection>/<id>` publishes that record and leaves a sibling written by another
		// session exactly as pending as it found it.
		const rows = !targets.scoped ? all : all.filter((r) => {
			const ref = `${r.collection}/${r.id}`;
			return targets.records.has(ref) || targets.whole.has(r.collection) || sweep.has(ref);
		});
		if (!rows.length) continue;
		const blocked = inProgress(cwd);
		if (blocked) { results.push({ repo, rows, blocked }); continue; }
		// ⚠ BEFORE the commit below — `moved` compares against HEAD, and committing moves HEAD. Only
		// for a whole-collection target: the record-scoped form either sweeps a moved partner in or
		// refuses over it, so it can leave none behind, and asking would cost a git read per dirty
		// row in the partner collections for an answer that is always empty.
		const published = new Set(rows.map((r) => `${r.collection}/${r.id}`));
		const leftPending = targets.whole.size ? partnersLeftPending(reader, published) : [];
		const warning = detached(cwd) ? 'HEAD is detached — this commit will be reachable only by sha' : null;
		const subject = message ?? composeSubject(rows);
		if (!dryRun) {
			const paths = rows.map((r) => r.repoRel);
			// A rename only reports as `R` once it is STAGED, so its old path is in neither the
			// worktree nor the index and `git add` refuses it ("did not match any files"). It needs
			// no adding — only naming, so the partial commit below carries the deletion half too.
			const alreadyStaged = rows.filter((r) => r.fromRel).map((r) => r.fromRel);
			// `--all` here is PATHSPEC-SCOPED — "including deletions of these named files", not
			// "everything in the tree" (the unscoped form CLAUDE.md rule 6 forbids). Same shape
			// store.js has always used.
			execFileSync('git', ['add', '--all', '--', ...paths], { cwd });
			execFileSync('git', ['commit', '--quiet', '-m', subject, '--', ...paths, ...alreadyStaged], { cwd });
		}
		const sha = dryRun ? null : execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd }).toString().trim();
		results.push({ repo, rows, subject, sha, warning, leftPending });
	}
	return results;
}
