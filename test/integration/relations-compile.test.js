// Tier 2 — compile is the ONLY producer of the compiled relation shape, and it accepts TWO source
// spellings for the same relation: `x-inverse` on the owning (foreign-key) side, or `x-inverse-of`
// on the side that wants the mirror. Both must land on disk as the SAME bytes, because everything
// downstream (relations.js, check, the store's mirror maintenance) reads the compiled artifact and
// must never learn that two spellings existed.
//
// The load-bearing assertions are therefore (a) the generated mirror's exact shape and (b) the
// byte-for-byte equality of the two spellings — an assertion no unit test can make, because the
// thing being compared is the artifact.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, simpleCollection, compileError, compileQuietly, readFile, WS_MODULE } from '../helpers/ws.js';
import { load, dump } from '../../src/yaml.js';
import { presentation } from '../../src/presentation.js';
import { loadDescriptors } from '../../src/runtime.js';

// The four-collection cast every case here is cut from: one anchor plus the three cardinalities —
// many-to-one (recordings), one-to-one (summaries, via x-unique) and many-to-many (analyses).
const MEETINGS = simpleCollection({ storage: { suffix: 'meeting' } });

const RECORDINGS = simpleCollection({
	storage: { suffix: 'recording' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			meeting: { type: 'string', 'x-reference': 'meetings', 'x-inverse': 'recordings' },
		},
	},
});

const SUMMARIES = simpleCollection({
	storage: { suffix: 'summary' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			meeting: { type: 'string', 'x-reference': 'meetings', 'x-unique': true, 'x-inverse': 'summary' },
		},
	},
});

const ANALYSES = simpleCollection({
	storage: { suffix: 'analysis' },
	schema: {
		type: 'object',
		required: ['name'],
		properties: {
			name: { type: 'string' },
			// authored on the PROPERTY: normalizeRelationKeywords hoists it onto `items`, which is
			// where every relation consumer reads it from
			meetings: { type: 'array', 'x-inverse': 'analyses', items: { type: 'string', 'x-reference': 'meetings' } },
		},
	},
});

const relWorkspace = () => workspace({
	collections: { meetings: MEETINGS, recordings: RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES },
});

describe('compile materializes relations', () => {
	test('spelling A stamps a readOnly mirror on the target', () => {
		const ws = relWorkspace();
		const meetings = load(readFile(ws.root, '.dreamteamer/collections/meetings.collection.yaml'));
		const rec = meetings.schema.properties.recordings;
		assert.equal(rec.type, 'array');
		assert.equal(rec.readOnly, true);
		assert.equal(rec.items['x-reference'], 'recordings');
		assert.equal(rec.items['x-inverse-of'], 'recordings.meeting');
		assert.match(rec.description, /Generated from recordings\.meeting/);
		const sum = meetings.schema.properties.summary;
		assert.equal(sum.type, 'string'); // unique ⇒ scalar mirror
		assert.equal(sum['x-inverse-of'], 'summaries.meeting');
	});

	test('spelling B compiles to the identical pair (spelling equivalence)', () => {
		// same relation declared from the OTHER side: meetings authors the mirror, recordings has a plain ref
		const B_RECORDINGS = structuredClone(RECORDINGS);
		delete B_RECORDINGS.schema.properties.meeting['x-inverse'];
		const B_MEETINGS = simpleCollection({ storage: { suffix: 'meeting' } });
		B_MEETINGS.schema.properties.recordings = {
			type: 'array',
			items: { type: 'string', 'x-reference': 'recordings' },
			'x-inverse-of': 'recordings.meeting',
		};
		const a = relWorkspace();
		const b = workspace({ collections: { meetings: B_MEETINGS, recordings: B_RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES } });
		for (const f of ['meetings', 'recordings']) {
			assert.equal(
				readFile(b.root, `.dreamteamer/collections/${f}.collection.yaml`),
				readFile(a.root, `.dreamteamer/collections/${f}.collection.yaml`),
				`${f}: spelling B must compile byte-identical to spelling A`);
		}
	});

	test('a scalar spelling-B mirror closes cardinality backwards: x-unique lands on the FK', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.summary = { type: 'string', 'x-inverse-of': 'summaries.meeting' };
		const S = structuredClone(SUMMARIES);
		delete S.schema.properties.meeting['x-unique'];
		delete S.schema.properties.meeting['x-inverse'];
		const ws = workspace({ collections: { meetings: M, summaries: S } });
		const compiled = load(readFile(ws.root, '.dreamteamer/collections/summaries.collection.yaml'));
		assert.equal(compiled.schema.properties.meeting['x-unique'], true);
	});
});

describe('compile refuses a mirror it would generate in a shape nobody can write', () => {
	test('a required field that a relation generates as a readOnly mirror fails compile — both spellings', () => {
		// spelling A: the target never authored the field at all, but names it in `required` — the
		// mirror lands readOnly and every record is then invalid the moment it is written by hand.
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.required = ['name', 'recordings'];
		const a = workspace({ compile: false, collections: { meetings: M, recordings: RECORDINGS } });
		assert.match(compileError(a.ws), /"recordings" is required, but recordings\.meeting generates it/);

		// spelling B reaches the SAME guard: pass 1 deletes the authored field and pass 2 puts the
		// generated one back under the same key, so `required` still names it.
		const B_M = simpleCollection({ storage: { suffix: 'meeting' } });
		B_M.schema.required = ['name', 'recordings'];
		B_M.schema.properties.recordings = {
			type: 'array',
			items: { type: 'string', 'x-reference': 'recordings' },
			'x-inverse-of': 'recordings.meeting',
		};
		const B_R = structuredClone(RECORDINGS);
		delete B_R.schema.properties.meeting['x-inverse'];
		const b = workspace({ compile: false, collections: { meetings: B_M, recordings: B_R } });
		assert.match(compileError(b.ws), /"recordings" is required, but recordings\.meeting generates it/);
	});

	test('a hand-authored mirror keeps description and x-title-template; a shape mismatch is a collision', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.recordings = {
			type: 'array',
			description: 'The captures of this call.',
			items: { type: 'string', 'x-reference': 'recordings', 'x-title-template': '{{ name }} ({{ id }})' },
			'x-nonsense': 'dropped', // everything except the two carried keywords is discarded
		};
		const ws = workspace({ collections: { meetings: M, recordings: RECORDINGS } });
		const meetings = load(readFile(ws.root, '.dreamteamer/collections/meetings.collection.yaml'));
		const rec = meetings.schema.properties.recordings;
		assert.equal(rec.readOnly, true);
		assert.equal(rec.description, 'The captures of this call.');
		assert.equal(rec.items['x-title-template'], '{{ name }} ({{ id }})');
		assert.equal(rec['x-nonsense'], undefined);

		// an array mirror whose ITEMS are a different type is a real collision, not the tolerated
		// both-sides spelling — the old shape test only compared the outer type and let it through
		const BAD = simpleCollection({ storage: { suffix: 'meeting' } });
		BAD.schema.properties.recordings = {
			type: 'array',
			items: { type: 'object', 'x-reference': 'recordings' },
		};
		const bad = workspace({ compile: false, collections: { meetings: BAD, recordings: RECORDINGS } });
		assert.match(compileError(bad.ws), /collides with the mirror generated from recordings\.meeting/);
	});
});

describe('compile refuses malformed relations', () => {
	test("x-inverse on '*' is an error", () => {
		const BAD = simpleCollection({ storage: { suffix: 'note' } });
		BAD.schema.properties.about = { type: 'string', 'x-reference': '*', 'x-inverse': 'notes' };
		const err = compileError(workspace({ collections: { notes: BAD }, compile: false }).ws);
		assert.match(err, /x-inverse on x-reference '\*'/);
	});
	test('both sides disagreeing is an error', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.captures = { type: 'array', items: { type: 'string', 'x-reference': 'recordings' }, 'x-inverse-of': 'recordings.meeting' };
		const err = compileError(workspace({ collections: { meetings: M, recordings: RECORDINGS }, compile: false }).ws);
		assert.match(err, /declared on both sides and they disagree/);
	});
	test('set-null on a required FK is an error', () => {
		const R = structuredClone(RECORDINGS);
		R.schema.required = ['name', 'meeting'];
		R.schema.properties.meeting['x-on-delete'] = 'set-null';
		const err = compileError(workspace({ collections: { meetings: MEETINGS, recordings: R }, compile: false }).ws);
		assert.match(err, /set-null would produce an invalid record/);
	});
	test('set-null on a list with a FLOOR is refused too — rm would leave it short', () => {
		// The same hole as `required`, one shape along, and it was open: `rm` clears set-null by
		// removing the ONE entry that named the deleted record, so a floor above 1 can be broken
		// without the key ever going away. Measured before the guard: `dt rm meetings/kickoff` printed
		// `✔ removed` and `dt check` then reported `must NOT have fewer than 2 items` on a record
		// nobody had touched — `rm` does not validate the owners it rewrites, on purpose.
		const listFk = (minItems) => {
			const R = simpleCollection({ storage: { suffix: 'recording' } });
			R.schema.properties.meetings = {
				type: 'array', ...(minItems === undefined ? {} : { minItems }),
				items: { type: 'string', 'x-reference': 'meetings', 'x-inverse': 'recordings', 'x-on-delete': 'set-null' },
			};
			return workspace({ collections: { meetings: MEETINGS, recordings: R }, compile: false }).ws;
		};
		assert.match(compileError(listFk(2)), /declares minItems: 2 — x-on-delete: set-null removes ONE entry/);
		// ⚠ minItems: 1 is SAFE and must keep compiling: the last entry takes the KEY with it, and an
		// absent list reads exactly like an empty one to every reader. Refusing it would refuse a
		// working configuration.
		assert.equal(compileError(listFk(1)), null, 'minItems: 1 empties to an ABSENT key, which is valid');
		assert.equal(compileError(listFk(undefined)), null);
	});

	test('array mirror of a unique FK is a cardinality error', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.summaries = { type: 'array', items: { type: 'string', 'x-reference': 'summaries' }, 'x-inverse-of': 'summaries.meeting' };
		const S = structuredClone(SUMMARIES); delete S.schema.properties.meeting['x-inverse'];
		const err = compileError(workspace({ collections: { meetings: M, summaries: S }, compile: false }).ws);
		assert.match(err, /array mirror of the unique FK/);
	});
	test('x-unique with no relation WARNS — it is inert, and silence was the bug', () => {
		// It is not a JSON Schema keyword, so ajv ignores it; `relationsOf` decodes a relation from
		// `x-inverse`, so with no mirror there is no relation row, and therefore no constraint in
		// `check` (which tests uniqueness per relation) and none at write time (the store enforces it
		// while maintaining a mirror). A descriptor asking for a one-to-one and getting nothing.
		const fk = (extra) => {
			const R = simpleCollection({ storage: { suffix: 'recording' } });
			R.schema.properties.meeting = { type: 'string', 'x-reference': 'meetings', 'x-unique': true, ...extra };
			return compileQuietly(workspace({ collections: { meetings: MEETINGS, recordings: R }, compile: false }).ws)
				.warnings.filter((w) => w.includes('x-unique'));
		};
		const inert = fk({});
		assert.equal(inert.length, 1, `expected one x-unique warning, got: ${JSON.stringify(inert)}`);
		assert.match(inert[0], /x-unique on "meeting" is inert/);
		assert.match(inert[0], /--name meeting --inverse/); // the remedy, as a command

		// an ARRAY FK is the shape the report came in as — same answer, since nothing reads it either
		const R = simpleCollection({ storage: { suffix: 'recording' } });
		R.schema.properties.meetings = { type: 'array', items: { type: 'string', 'x-reference': 'meetings', 'x-unique': true } };
		const list = compileQuietly(workspace({ collections: { meetings: MEETINGS, recordings: R }, compile: false }).ws)
			.warnings.filter((w) => w.includes('x-unique'));
		assert.equal(list.length, 1, JSON.stringify(list));

		// ⚠ and NOT on a real relation — the warning must not fire on the shape it is telling you to write
		assert.deepEqual(fk({ 'x-inverse': 'recording' }), []);
	});

	test('x-unique on a LIST foreign key is an error — three components read it differently', () => {
		// M5. Nothing could honour it: relationsOf calls the pair m2m, stampMirror generates the
		// SCALAR mirror x-unique implies, `dt relations` prints "m2m" beside that scalar, check never
		// tests uniqueness for a list, and the store enforces it at write time anyway. A keyword no
		// component agrees about is a descriptor error, not a runtime surprise.
		const A = structuredClone(ANALYSES);
		A.schema.properties.meetings.items['x-unique'] = true;
		const err = compileError(workspace({ collections: { meetings: MEETINGS, analyses: A }, compile: false }).ws);
		assert.match(err, /field "meetings" is a list, and x-unique means the foreign key is one-to-one/);
	});
	test('a typo\'d COLLECTION in x-inverse-of names the collection, not the field', () => {
		// M6. "no such field exists" sent the reader looking at a field that is spelled correctly, in
		// a collection that does not exist.
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.captures = { type: 'array', items: { type: 'string', 'x-reference': 'recordings' }, 'x-inverse-of': 'recordinggs.meeting' };
		const err = compileError(workspace({ collections: { meetings: M, recordings: RECORDINGS }, compile: false }).ws);
		assert.match(err, /there is no collection "recordinggs"/);
	});
	test('the legacy both-sides shape compiles with a warning', () => {
		const M = structuredClone(MEETINGS);
		M.schema.properties.recordings = { type: 'array', items: { type: 'string', 'x-reference': 'recordings' } };
		const ws = workspace({ collections: { meetings: M, recordings: RECORDINGS } });
		assert.ok(ws.out.warnings.some((w) => w.includes('hand-authored but recordings.meeting declares it')));
	});
	// A mirror is a FIELD the store writes onto a target record. Two kinds of collection have nowhere
	// to put one, and both were found by pointing a relation at them and watching the store do damage:
	// a `codec: file` target had its bytes replaced with frontmatter (an SVG asset came back as YAML),
	// and a runtime target had the mirror written into `.dreamteamer/`, which is gitignored and
	// overwritten by the next compile. Neither is a store bug to patch — the descriptor is asking for
	// something that cannot exist, so compile is where it stops.
	test('a mirror onto a `codec: file` target is refused — the bytes ARE the record', () => {
		const ASSETS = { description: 'Opaque files.', storage: { path: 'data/assets', codec: 'file', shape: 'file', suffix: 'asset', extensions: ['svg'] }, id: { pattern: '^[a-z0-9][a-z0-9/._-]*$' } };
		const CARDS = simpleCollection({ storage: { suffix: 'card' } });
		CARDS.schema.properties.icon = { type: 'string', 'x-reference': 'assets', 'x-inverse': 'cards' };
		const err = compileError(workspace({ compile: false, collections: { assets: ASSETS, cards: CARDS } }).ws);
		assert.match(err, /stamps a mirror onto assets, whose records ARE files \(codec: file\)/);
	});

	test('a mirror onto an md target with no x-body is refused — the body would be destroyed', () => {
		// The THIRD shape that cannot hold a mirror, and the quietest: `serialize` keeps a body only
		// where the descriptor declares an `x-body` field, and `dt add collections` with no
		// template produces a `codec: md` collection with none. Hand-written prose in such a record is
		// invisible to the parser, so a mirror write on the far side of somebody else's `dt add`
		// rewrites the file without it — and `check` is silent before and after.
		// NOT simpleCollection: that fixture carries a body field precisely because a mirror target
		// must. This is what `dt add collections --name notes` writes with no template.
		const NOTES = { id: { generate: '{{ name | slug }}' }, storage: { suffix: 'note' }, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } };
		const TICKETS = simpleCollection({ storage: { suffix: 'ticket' } });
		TICKETS.schema.properties.note = { type: 'string', 'x-reference': 'notes', 'x-inverse': 'tickets' };
		const err = compileError(workspace({ compile: false, collections: { notes: NOTES, tickets: TICKETS } }).ws);
		assert.match(err, /stamps a mirror onto notes, whose descriptor declares no x-body/);
		// and the remedy is a RUNNABLE command, not an instruction with no verb behind it
		assert.match(err, /dreamteamer add-field notes --name notes --type markdown --body/);
	});

	test('a mirror onto a compiled-source target is refused — the next compile would erase it', () => {
		// `skills` is runtime-based and contributed by the engine itself, so this is the shape a real
		// workspace would reach for: "which of my records use this skill".
		const USES = simpleCollection({ storage: { suffix: 'use' } });
		USES.schema.properties.skill = { type: 'string', 'x-reference': 'skills', 'x-inverse': 'used_by' };
		const err = compileError(workspace({ compile: false, collections: { uses: USES } }).ws);
		assert.match(err, /stamps a mirror onto skills, whose records are compiled sources/);
	});

	test('self-reference works with a distinct mirror name', () => {
		const C = simpleCollection({ storage: { suffix: 'company' } });
		C.schema.properties.parent = { type: 'string', 'x-reference': 'companies', 'x-inverse': 'subsidiaries' };
		const ws = workspace({ collections: { companies: C } });
		const compiled = load(readFile(ws.root, '.dreamteamer/collections/companies.collection.yaml'));
		assert.equal(compiled.schema.properties.subsidiaries.items['x-inverse-of'], 'companies.parent');
	});
	test('two relations generating ONE mirror name on one target is an error', () => {
		// The unfixable case: both mirrors are arrays of x-reference transactions, so the shape
		// collision guard passes them, and check then computes two contradictory expectations for
		// claims.transactions that no value can satisfy and no rebuild can repair.
		const T = simpleCollection({ storage: { suffix: 'txn' } });
		T.schema.properties.claim = { type: 'string', 'x-reference': 'claims', 'x-inverse': 'transactions' };
		T.schema.properties.reimburses_claim = { type: 'string', 'x-reference': 'claims', 'x-inverse': 'transactions' };
		const err = compileError(workspace({ compile: false, collections: { claims: simpleCollection({ storage: { suffix: 'claim' } }), transactions: T } }).ws);
		assert.match(err, /both transactions\.claim and transactions\.reimburses_claim generate a mirror named "transactions"/);
	});

	test('double reference into one target works with distinct mirror names', () => {
		const T = simpleCollection({ storage: { suffix: 'txn' } });
		T.schema.properties.claim = { type: 'string', 'x-reference': 'claims', 'x-inverse': 'expense_transactions' };
		T.schema.properties.reimburses_claim = { type: 'string', 'x-reference': 'claims', 'x-inverse': 'reimbursement_transactions' };
		const ws = workspace({ collections: { claims: simpleCollection({ storage: { suffix: 'claim' } }), transactions: T } });
		const claims = load(readFile(ws.root, '.dreamteamer/collections/claims.collection.yaml'));
		assert.ok(claims.schema.properties.expense_transactions && claims.schema.properties.reimbursement_transactions);
	});
});


// ---- check, against the same cast ------------------------------------------------------------
// A mirror is DERIVED state: the owning side's FK is the truth, and the mirror is a cache of it.
// So check never asks "do both sides agree" — it recomputes what the owners imply and compares.
//
// ⚠ Every staleness case below is HAND-MADE, and has to be: the store maintains mirrors on add/set,
// so a workspace written through the tools is never stale. What check exists for is the state the
// tools cannot produce — a record hand-edited on one side, one written by an engine that predates
// relations, or a git merge that took one side of each file.
describe('check verifies mirrors', () => {
	test('a mirror the owning side has outgrown is flagged with the rebuild hint', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		// strip the mirror the store just wrote: the recording still claims the meeting, and the
		// meeting now carries no `recordings` at all — the shape every pre-relations record is in
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/recordings:\n  - recordings\/cap1\n/, ''));
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /recordings: stale — run: dreamteamer relations rebuild meetings/);
	});

	test('a hand-edited mirror pointing somewhere else is stale, not merely dangling', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		// vandalize the mirror the store wrote — a value that resolves to nothing AND disagrees with
		// the owner
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('recordings/cap1', 'recordings/ghost'));
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		// `recordings/ghost` is also a dangling reference; the staleness finding is the one under test
		assert.match(res.stdout, /recordings: stale — run: dreamteamer relations rebuild meetings/);
	});

	test('a mirror that matches the owning side is silent', () => {
		// No hand-editing left to do — the store writes exactly this mirror, so the assertion is now
		// that check and the store agree about what a maintained mirror looks like. They read the same
		// relation rows through src/relations.js; this is what proves it end to end.
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		assert.match(readFile(ws.root, 'data/meetings/standup.meeting.md'), /recordings:\n  - recordings\/cap1/);
		const res = ws.dt('check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
	});

	test('x-unique refuses two summaries for one meeting', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		assert.equal(ws.dt('add', 'summaries', '--name', 'One', '--meeting', 'meetings/standup').code, 0);
		// bypass the store to plant the duplicate, then check must catch it
		fs.writeFileSync(`${ws.root}/data/summaries/two.summary.md`, '---\nname: Two\nmeeting: meetings/standup\n---\n');
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /meeting: "meetings\/standup" is already taken by summaries\/one \(x-unique\)/);
	});
});

// ---- the legacy MUTUAL spelling ---------------------------------------------------------------
// 0.14 shipped docs that spelled a two-way link with `x-inverse` on BOTH sides, and the design doc
// promises that shape keeps compiling for one minor — a warning, not an error. Read as two
// relations it is fatal: each side's mirror lands on the other's authored field. It is ONE edge
// described twice, so compile collapses it to one relation and the compiled bytes must be exactly
// what the single-sided spelling produces — that is the whole claim, hence the byte-compare.
describe('the mutual x-inverse spelling is one relation', () => {
	// meetings.recordings ⟷ meeting-recordings.meeting, the pair the developing workspace ships
	const MUTUAL_MEETINGS = simpleCollection({ storage: { suffix: 'meeting' } });
	MUTUAL_MEETINGS.schema.properties.recordings = {
		type: 'array',
		items: { type: 'string', 'x-reference': 'recordings' },
		'x-inverse': 'meeting',
	};

	test('compiles byte-identical to spelling A, with ONE warning', () => {
		const a = relWorkspace();
		const m = workspace({ collections: { meetings: MUTUAL_MEETINGS, recordings: RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES } });
		for (const f of ['meetings', 'recordings']) {
			assert.equal(
				readFile(m.root, `.dreamteamer/collections/${f}.collection.yaml`),
				readFile(a.root, `.dreamteamer/collections/${f}.collection.yaml`),
				`${f}: the mutual spelling must compile byte-identical to spelling A`);
		}
		const mine = m.out.warnings.filter((w) => w.includes('declared on BOTH sides'));
		assert.equal(mine.length, 1, `one warning per pair, got: ${JSON.stringify(m.out.warnings)}`);
		assert.match(mine[0], /recordings\.meeting owns it/);
		assert.match(mine[0], /delete/); // the migration, not just the diagnosis
	});

	test('both sides scalar: the x-unique side owns', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.summary = { type: 'string', 'x-reference': 'summaries', 'x-inverse': 'meeting' };
		const ws = workspace({ collections: { meetings: M, summaries: SUMMARIES } });
		const meetings = load(readFile(ws.root, '.dreamteamer/collections/meetings.collection.yaml'));
		assert.equal(meetings.schema.properties.summary['x-inverse-of'], 'summaries.meeting');
		assert.equal(meetings.schema.properties.summary.readOnly, true);
	});

	/**
	 * The SAME pair of collections, compiled in OPPOSITE discovery orders.
	 *
	 * ⚠ THE ORDER COMES FROM THE FILENAMES, and that is the whole reason this helper exists. Both
	 * tests below used to build `workspace({ collections: { alpha, zulu } })` and
	 * `workspace({ collections: { zulu, alpha } })` and call the two "both discovery orders" — but
	 * `workspace()` writes one file per collection at `collections/<name>.collection.yaml` and compile
	 * enumerates that directory with `readdirSync().sort()`. The two workspaces were byte-identical:
	 * the tests compiled the same thing twice, asserted the same answer twice, and could not fail for
	 * the reason they named.
	 *
	 * A descriptor's collection name is its `name:` key, and its runtime path is derived from that —
	 * so the FILE may be called anything, which is what actually lets the order be reversed. The
	 * manifest assertion is not decoration: it proves the inversion happened, so that if `workspace()`
	 * ever starts writing these files itself the vacuity cannot come back unnoticed.
	 */
	function bothDiscoveryOrders(first, second) {
		return [[first, second], [second, first]].map(([a, b]) => {
			const ws = workspace({ compile: false });
			const dir = path.join(ws.root, 'modules', WS_MODULE, 'collections');
			fs.writeFileSync(path.join(dir, '1-read-first.collection.yaml'), dump({ name: a.name, ...a.descriptor }));
			fs.writeFileSync(path.join(dir, '2-read-second.collection.yaml'), dump({ name: b.name, ...b.descriptor }));
			compileQuietly(ws.ws);
			const entries = load(readFile(ws.root, '.dreamteamer/manifest.yaml')).entries;
			assert.match(
				entries[`collections/${a.name}.collection.yaml`].sources[0].path,
				/1-read-first/,
				`${a.name} was meant to be discovered FIRST in this run — without that these two runs are one run twice`);
			return ws;
		});
	}

	test('both sides scalar with no x-unique: the name decides, and both directions agree', () => {
		// neither side is the obvious owner, so the pick must be reproducible rather than
		// discovery-order dependent — alpha.link owns because "alpha.link" < "zulu.link"
		const mk = (target) => {
			const c = simpleCollection({ storage: { suffix: 'x' } });
			c.schema.properties.link = { type: 'string', 'x-reference': target, 'x-inverse': 'link' };
			return c;
		};
		for (const ws of bothDiscoveryOrders(
			{ name: 'alpha', descriptor: mk('zulu') },
			{ name: 'zulu', descriptor: mk('alpha') },
		)) {
			const zulu = load(readFile(ws.root, '.dreamteamer/collections/zulu.collection.yaml'));
			assert.equal(zulu.schema.properties.link['x-inverse-of'], 'alpha.link');
			// …and the far side is the writable owner in BOTH runs. Asserting only the mirror lets an
			// order-dependent implementation pass by making both sides read-only.
			const alpha = load(readFile(ws.root, '.dreamteamer/collections/alpha.collection.yaml'));
			assert.equal(alpha.schema.properties.link['x-inverse'], 'link');
			assert.equal(alpha.schema.properties.link.readOnly, undefined);
		}
	});

	test('both sides array: a many-to-many written twice, resolved lexicographically', () => {
		const mk = (target, inverse) => {
			const c = simpleCollection({ storage: { suffix: 'x' } });
			c.schema.properties[inverse === 'papers' ? 'topics' : 'papers'] = {
				type: 'array', items: { type: 'string', 'x-reference': target }, 'x-inverse': inverse,
			};
			return c;
		};
		// compiled in BOTH discovery orders: the owner may not depend on which descriptor was read
		// first, which is exactly what the pre-fix behaviour did — whichever side stamped first won
		for (const ws of bothDiscoveryOrders(
			{ name: 'papers', descriptor: mk('topics', 'papers') },
			{ name: 'topics', descriptor: mk('papers', 'topics') },
		)) {
			const topics = load(readFile(ws.root, '.dreamteamer/collections/topics.collection.yaml'));
			assert.equal(topics.schema.properties.papers.items['x-inverse-of'], 'papers.topics');
			assert.equal(topics.schema.properties.papers.readOnly, true);
			// and the OWNER stays writable — read as two relations, whichever side loses the race
			// comes back readOnly, and an edge with no writable side is one nobody can set
			const papers = load(readFile(ws.root, '.dreamteamer/collections/papers.collection.yaml'));
			assert.equal(papers.schema.properties.topics.readOnly, undefined);
			assert.equal(papers.schema.properties.topics.items['x-inverse'], 'papers');
		}
	});

	test('the migration names EVERY descriptor the folded field could be in, not sources[0]', () => {
		// A collection assembled from a base plus an `extends:` overlay has SEVERAL descriptor files,
		// and the field this warning says to delete may be authored in any of them. The message used to
		// name `sources[0]` — a guess. Following a wrong guess means opening a file that does not
		// contain the field, changing nothing, and meeting the same warning on the next compile.
		const ws = workspace({
			compile: false,
			collections: { meetings: simpleCollection({ storage: { suffix: 'meeting' } }), recordings: RECORDINGS },
		});
		// the mutual half is authored in the OVERLAY, so the base is exactly the wrong file to be sent to
		fs.writeFileSync(
			path.join(ws.root, 'modules', WS_MODULE, 'collections', 'meetings-overlay.collection.yaml'),
			`name: meetings\nextends: ${WS_MODULE}/meetings\nschema:\n  properties:\n    recordings:\n      type: array\n      'x-inverse': meeting\n      items: { type: string, 'x-reference': recordings }\n`,
		);
		const out = compileQuietly(ws.ws);
		const warn = out.warnings.find((w) => w.includes('declared on BOTH sides'));
		assert.ok(warn, `no mutual-spelling warning: ${JSON.stringify(out.warnings)}`);
		assert.match(warn, /recordings\.meeting owns it/);
		for (const f of ['meetings.collection.yaml', 'meetings-overlay.collection.yaml']) {
			const p = `modules/${WS_MODULE}/collections/${f}`;
			assert.ok(warn.includes(p), `the warning must name ${p}, so the author can grep both:\n${warn}`);
		}
	});

	test('a mutual self-reference collapses to one relation', () => {
		const C = simpleCollection({ storage: { suffix: 'company' } });
		C.schema.properties.parent = { type: 'string', 'x-reference': 'companies', 'x-inverse': 'subsidiaries' };
		C.schema.properties.subsidiaries = { type: 'array', items: { type: 'string', 'x-reference': 'companies' }, 'x-inverse': 'parent' };
		const ws = workspace({ collections: { companies: C } });
		const compiled = load(readFile(ws.root, '.dreamteamer/collections/companies.collection.yaml'));
		assert.equal(compiled.schema.properties.subsidiaries.items['x-inverse-of'], 'companies.parent');
		assert.equal(compiled.schema.properties.parent['x-inverse'], 'subsidiaries');
	});
});


// ---- presentation ------------------------------------------------------------------------------
// presentation is the ENGINE'S contract with every surface: the extension reads these rows and never
// the raw descriptors. A relation the compiler materializes but presentation does not project is a
// relation no UI can render as one — the mirror shows up as an ordinary editable reference list,
// which is exactly the field the store refuses to write.
describe('presentation projects relations', () => {
	test('owner meta, mirror meta, and the kind on the relation rows', () => {
		const ws = relWorkspace();
		const p = presentation(loadDescriptors(ws.root));

		const meetings = Object.fromEntries(p.fields.meetings.map((r) => [r.field, r]));
		assert.equal(meetings.recordings.meta.readonly, true);
		assert.equal(meetings.recordings.meta.inverse_of, 'recordings.meeting');
		assert.ok(meetings.recordings.meta.special.includes('dt-relation-mirror'));
		// the hint is the sentence compile generated, so a disabled control can say WHY
		assert.match(meetings.recordings.meta.readonly_hint, /Generated from recordings\.meeting/);
		// a unique FK's mirror is a SCALAR, and it is read-only just the same
		assert.equal(meetings.summary.meta.readonly, true);
		assert.equal(meetings.summary.meta.inverse_of, 'summaries.meeting');

		const recs = Object.fromEntries(p.fields.recordings.map((r) => [r.field, r]));
		assert.equal(recs.meeting.meta.inverse, 'recordings');
		assert.equal(recs.meeting.meta.on_delete, 'restrict'); // the default, stated rather than implied
		assert.equal(recs.meeting.meta.readonly, undefined);   // the OWNER is the writable side
		const sums = Object.fromEntries(p.fields.summaries.map((r) => [r.field, r]));
		assert.equal(sums.meeting.meta.unique, true);

		// the same three names src/relations.js decodes — no surface learns a second vocabulary
		const kindOf = (collection, field) => p.relations.find((r) => r.collection === collection && r.field === field);
		assert.equal(kindOf('recordings', 'meeting').kind, 'm2o');
		assert.equal(kindOf('summaries', 'meeting').kind, 'o2o');
		assert.equal(kindOf('analyses', 'meetings').kind, 'm2m');
		const mirrorRow = kindOf('meetings', 'recordings');
		assert.equal(mirrorRow.mirror, true);
		assert.equal(mirrorRow.kind, undefined); // a mirror has no cardinality of its own
	});
});

describe('x-body — the remedy the mirror refusal names', () => {
	/** A `codec: md` collection with no `x-body`: nowhere for a record's prose to parse into, so
	 *  nowhere for a mirror write to put it back. simpleCollection deliberately HAS one, which is
	 *  why this case has to be spelled out by hand. */
	const BODYLESS = {
		id: { generate: '{{ name | slug }}' },
		storage: { suffix: 'plain' },
		schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
	};

	test('the refusal quotes a command that actually declares one', () => {
		const err = compileError(workspace({
			compile: false,
			collections: {
				plain: BODYLESS,
				recordings: simpleCollection({
					storage: { suffix: 'recording' },
					schema: {
						type: 'object', required: ['name'],
						properties: {
							name: { type: 'string' },
							plain: { type: 'string', 'x-reference': 'plain', 'x-inverse': 'recordings' },
						},
					},
				}),
			},
		}).ws);
		assert.match(err, /declares no x-body/);
		// THE POINT: for one minor this said "declare an x-body field" and no verb could do it —
		// `add-field` had no flag that marks one. A named remedy has to name its command.
		assert.match(err, /dreamteamer add-field plain --name notes --type markdown --body/);
	});

	test('running that exact command makes the relation compile', () => {
		const ws = workspace({ collections: { plain: BODYLESS } });
		const add = ws.dt('add-field', 'plain', '--name', 'notes', '--type', 'markdown', '--body');
		assert.equal(add.code, 0, add.stderr);
		const d = load(readFile(ws.root, 'modules/default/collections/plain.collection.yaml'));
		assert.equal(d.schema.properties.notes['x-body'], true, '--body has to write the keyword, not swallow the flag');

		const rel = ws.dt('add-field', 'plain', '--name', 'twin', '--type', 'plain', '--inverse', 'twins');
		assert.equal(rel.code, 0, rel.stdout + rel.stderr);
	});

	test('a SECOND body is refused — a record has one', () => {
		const two = {
			...BODYLESS,
			schema: {
				type: 'object', required: ['name'],
				properties: {
					name: { type: 'string' },
					notes: { type: 'string', format: 'markdown', 'x-body': true },
					summary: { type: 'string', format: 'markdown', 'x-body': true },
				},
			},
		};
		const err = compileError(workspace({ compile: false, collections: { plain: two } }).ws);
		assert.match(err, /2 fields declare x-body \(notes, summary\)/);
		assert.match(err, /Keep one/);
	});

	test('--body on a field that cannot hold prose is refused, naming the type that can', () => {
		const ws = workspace({ collections: { plain: BODYLESS } });
		const res = ws.dt('add-field', 'plain', '--name', 'count', '--type', 'number', '--body');
		assert.notEqual(res.code, 0);
		assert.match(res.stderr + res.stdout, /--type markdown/);
	});

	test('a retype that says nothing about the body keeps it', () => {
		// `update-field --description` rebuilds the prop from the flags alone, so an uncarried x-body
		// would silently un-body the field: the record's text then parses into nothing and the next
		// write serializes it away. Same carry rule as the relation keywords.
		const ws = workspace({ collections: { plain: BODYLESS } });
		assert.equal(ws.dt('add-field', 'plain', '--name', 'notes', '--type', 'markdown', '--body').code, 0);
		const res = ws.dt('update-field', 'plain', '--name', 'notes', '--description', 'what happened');
		assert.equal(res.code, 0, res.stderr);
		const d = load(readFile(ws.root, 'modules/default/collections/plain.collection.yaml'));
		assert.equal(d.schema.properties.notes['x-body'], true);
		assert.equal(d.schema.properties.notes.description, 'what happened');

		// …and --body false is how you deliberately clear it
		assert.equal(ws.dt('update-field', 'plain', '--name', 'notes', '--body', 'false').code, 0);
		const after = load(readFile(ws.root, 'modules/default/collections/plain.collection.yaml'));
		assert.equal(after.schema.properties.notes['x-body'], undefined);
	});
});
