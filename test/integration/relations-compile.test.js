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
import { load } from '../../src/yaml.js';
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
	test('array mirror of a unique FK is a cardinality error', () => {
		const M = simpleCollection({ storage: { suffix: 'meeting' } });
		M.schema.properties.summaries = { type: 'array', items: { type: 'string', 'x-reference': 'summaries' }, 'x-inverse-of': 'summaries.meeting' };
		const S = structuredClone(SUMMARIES); delete S.schema.properties.meeting['x-inverse'];
		const err = compileError(workspace({ collections: { meetings: M, summaries: S }, compile: false }).ws);
		assert.match(err, /array mirror of the unique FK/);
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

	test('both sides scalar with no x-unique: the name decides, and both directions agree', () => {
		// neither side is the obvious owner, so the pick must be reproducible rather than
		// discovery-order dependent — alpha.link owns because "alpha.link" < "zulu.link"
		const mk = (target) => {
			const c = simpleCollection({ storage: { suffix: 'x' } });
			c.schema.properties.link = { type: 'string', 'x-reference': target, 'x-inverse': 'link' };
			return c;
		};
		const forward = workspace({ collections: { alpha: mk('zulu'), zulu: mk('alpha') } });
		const backward = workspace({ collections: { zulu: mk('alpha'), alpha: mk('zulu') } });
		for (const ws of [forward, backward]) {
			const zulu = load(readFile(ws.root, '.dreamteamer/collections/zulu.collection.yaml'));
			assert.equal(zulu.schema.properties.link['x-inverse-of'], 'alpha.link');
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
		const forward = workspace({ collections: { papers: mk('topics', 'papers'), topics: mk('papers', 'topics') } });
		const backward = workspace({ collections: { topics: mk('papers', 'topics'), papers: mk('topics', 'papers') } });
		for (const ws of [forward, backward]) {
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
