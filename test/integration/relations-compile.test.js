// Tier 2 — compile is the ONLY producer of the compiled relation shape. A relation is declared once,
// on the MIRROR: a field `mirror_of: f` with `type: O` on collection T is the generated far side of
// O's reference field `f`. Everything downstream (relations.js, check, the store's mirror
// maintenance, presentation) reads the compiled artifact — `compiled.mirrors`, the resolved field's
// `mirror_of`, and the read-only property in `compiled.json_schema` — so those are what is asserted.
//
// Cardinality is read off the owner: a many mirror of a scalar reference is many-to-one, a scalar
// mirror of a unique scalar is one-to-one, a many mirror of a many reference is many-to-many.
// `relations-v2.test.js` pins those rules and the mirror's basic requirements; this file pins the
// compiled shape, the targets that cannot hold a mirror, check's staleness, and presentation.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace, simpleCollection, compileError, readFile, patchModulePkg, WS_MODULE } from '../helpers/ws.js';
import { load, dump } from '../../src/yaml.js';
import { presentation } from '../../src/presentation.js';
import { loadDescriptors } from '../../src/runtime.js';

/** A collection with `name`, the given fields, and the body a mirror target needs. */
const coll = (suffix, fields = {}) => simpleCollection({
	storage: { suffix },
	fields: { name: { type: 'string', required: true }, ...fields, notes: { type: 'markdown', body: true } },
});

// The four-collection cast every case here is cut from: one anchor plus the three cardinalities —
// many-to-one (recordings), one-to-one (summaries, via unique) and many-to-many (analyses).
const MEETINGS = coll('meeting', {
	recordings: { type: 'recordings', many: true, mirror_of: 'meeting' },
	summary: { type: 'summaries', mirror_of: 'meeting' },
	analyses: { type: 'analyses', many: true, mirror_of: 'meetings' },
});
const RECORDINGS = coll('recording', { meeting: { type: 'meetings' } });
const SUMMARIES = coll('summary', { meeting: { type: 'meetings', unique: true } });
const ANALYSES = coll('analysis', { meetings: { type: 'meetings', many: true } });

const relWorkspace = () => workspace({
	collections: { meetings: MEETINGS, recordings: RECORDINGS, summaries: SUMMARIES, analyses: ANALYSES },
});

const compiledOf = (ws, name) => load(readFile(ws.root, `.dreamteamer/collections/${name}.collection.yaml`));

describe('compile materializes relations', () => {
	test('the mirrors are listed in compiled.mirrors and read-only in the validator schema', () => {
		const ws = relWorkspace();
		const meetings = compiledOf(ws, 'meetings');
		assert.deepEqual([...meetings.compiled.mirrors].sort(), ['analyses', 'recordings', 'summary']);
		const rec = meetings.compiled.fields.recordings;
		assert.equal(rec.mirror_of, 'meeting');
		assert.equal(rec.many, true);
		assert.equal(rec.on_delete, undefined); // a mirror carries no delete rule — the owner does
		assert.deepEqual(meetings.compiled.json_schema.properties.recordings, { type: 'array', items: { type: 'string' }, uniqueItems: true, readOnly: true });
		// a unique owner's mirror is a SCALAR, read-only just the same
		assert.deepEqual(meetings.compiled.json_schema.properties.summary, { type: 'string', readOnly: true });

		// the OWNER is the writable side, with its delete rule stated rather than implied
		const recordings = compiledOf(ws, 'recordings');
		assert.deepEqual(recordings.compiled.mirrors, []);
		assert.equal(recordings.compiled.fields.meeting.on_delete, 'restrict');
		assert.equal(recordings.compiled.json_schema.properties.meeting.readOnly, undefined);
	});
});

describe('compile refuses a mirror in a shape nobody can write', () => {
	test('a required mirror fails compile — the owner writes it, so no hand-written record could satisfy it', () => {
		const M = coll('meeting', { recordings: { type: 'recordings', many: true, mirror_of: 'meeting', required: true } });
		const err = compileError(workspace({ compile: false, collections: { meetings: M, recordings: RECORDINGS } }).ws);
		assert.match(err, /field "recordings": a mirror cannot be required — the owner writes it/);
	});
});

describe('compile refuses malformed relations', () => {
	test('a mirror of a `type: reference` field is refused — an any-collection reference has no far side', () => {
		const N = coll('note', {
			about: { type: 'reference' },
			cited_by: { type: 'notes', many: true, mirror_of: 'about' },
		});
		const err = compileError(workspace({ collections: { notes: N }, compile: false }).ws);
		assert.match(err, /field "cited_by" is the mirror of notes\.about, which does not reference notes/);
	});
	test('set-null on a required reference is an error', () => {
		const R = coll('recording', { meeting: { type: 'meetings', required: true, on_delete: 'set-null' } });
		const err = compileError(workspace({ collections: { meetings: coll('meeting'), recordings: R }, compile: false }).ws);
		assert.match(err, /on_delete: set-null on a required reference would produce an invalid record/);
	});
	test('set-null on a list with a FLOOR is refused too — rm would leave it short', () => {
		// The same hole as `required`, one shape along: `rm` clears set-null by removing the ONE entry
		// that named the deleted record, so a floor above 1 can be broken without the key ever going
		// away — and `rm` does not validate the owners it rewrites, on purpose.
		const listFk = (minItems) => {
			const R = coll('recording', {
				meetings: { type: 'meetings', many: true, on_delete: 'set-null', ...(minItems === undefined ? {} : { minItems }) },
			});
			const M = coll('meeting', { recordings: { type: 'recordings', many: true, mirror_of: 'meetings' } });
			return workspace({ collections: { meetings: M, recordings: R }, compile: false }).ws;
		};
		assert.match(compileError(listFk(2)), /field "meetings" declares minItems: 2 — on_delete: set-null removes ONE entry/);
		// ⚠ minItems: 1 is SAFE and must keep compiling: the last entry takes the KEY with it, and an
		// absent list reads exactly like an empty one to every reader.
		assert.equal(compileError(listFk(1)), null, 'minItems: 1 empties to an ABSENT key, which is valid');
		assert.equal(compileError(listFk(undefined)), null);
	});
	test('unique on a LIST reference is an error — uniqueness is a value constraint on a scalar', () => {
		const A = coll('analysis', { meetings: { type: 'meetings', many: true, unique: true } });
		const err = compileError(workspace({ collections: { meetings: coll('meeting'), analyses: A }, compile: false }).ws);
		assert.match(err, /field "meetings": `unique` is a value constraint on a scalar field/);
	});
	test('a typo\'d COLLECTION in a mirror\'s type names the collection, not the field', () => {
		const M = coll('meeting', { captures: { type: 'recordinggs', many: true, mirror_of: 'meeting' } });
		const err = compileError(workspace({ collections: { meetings: M, recordings: RECORDINGS }, compile: false }).ws);
		assert.match(err, /field "captures": unknown type "recordinggs"/);
	});

	// A mirror is a FIELD the store writes onto a target record. Some collections have nowhere to put
	// one: a binary target's bytes ARE the record, a runtime target's records are rewritten by the
	// next compile, and an md target with no body would lose its prose on every mirror write. The
	// descriptor is asking for something that cannot exist, so compile is where it stops.
	test('a mirror onto a `format: binary` target is refused — the bytes ARE the record', () => {
		const ASSETS = {
			description: 'Opaque files.',
			storage: { path: 'data/assets', format: 'binary', suffix: 'asset', accept: ['svg'] },
			ids: { pattern: '^[a-z0-9][a-z0-9/._-]*$' },
			fields: { cards: { type: 'cards', many: true, mirror_of: 'icon' } },
		};
		const CARDS = coll('card', { icon: { type: 'assets' } });
		const err = compileError(workspace({ compile: false, collections: { assets: ASSETS, cards: CARDS } }).ws);
		assert.match(err, /field "cards" is a mirror, but assets's records are opaque files/);
	});

	test('a mirror onto an md target with no body is refused, and the refusal names the field to declare', () => {
		// NOT coll(): that fixture carries a body field precisely because a mirror target must.
		const NOTES = { ids: { from: '{{ name | slug }}' }, storage: { suffix: 'note' }, fields: { name: { type: 'string', required: true }, tickets: { type: 'tickets', many: true, mirror_of: 'note' } } };
		const TICKETS = coll('ticket', { note: { type: 'notes' } });
		const err = compileError(workspace({ compile: false, collections: { notes: NOTES, tickets: TICKETS } }).ws);
		assert.match(err, /field "tickets" is a mirror, but notes declares no body field/);
		// the remedy is the exact field to author, not an instruction with nothing behind it
		assert.match(err, /Declare one \(`notes: \{ type: markdown, body: true \}`\)/);
	});

	test('a mirror onto a compiled-source target is refused — the next compile would erase it', () => {
		// `skills` is runtime-based and contributed by the engine itself, so this is the shape a real
		// workspace would reach for: "which of my records use this skill".
		const USES = coll('use', { skill: { type: 'skills' } });
		const SKILLS = { overlay: true, fields: { used_by: { type: 'uses', many: true, mirror_of: 'skill' } } };
		const w = workspace({ compile: false, collections: { uses: USES, skills: SKILLS } });
		patchModulePkg(w.root, WS_MODULE, { dependencies: ['dreamteamer'] }); // an overlay of an engine collection depends on the engine
		assert.match(compileError(w.ws), /field "used_by" is a mirror, but skills's records are compiled sources/);
	});

	test('self-reference works with a distinct mirror name', () => {
		const C = coll('company', {
			parent: { type: 'companies' },
			subsidiaries: { type: 'companies', many: true, mirror_of: 'parent' },
		});
		const ws = workspace({ collections: { companies: C } });
		const compiled = compiledOf(ws, 'companies');
		assert.deepEqual(compiled.compiled.mirrors, ['subsidiaries']);
		assert.equal(compiled.compiled.fields.subsidiaries.mirror_of, 'parent');
		ws.dt('add', 'companies', '--name', 'Holding');
		assert.equal(ws.dt('add', 'companies', '--name', 'Branch', '--parent', 'companies/holding').code, 0);
		assert.deepEqual(JSON.parse(ws.dt('get', 'companies/holding', '--json').stdout).subsidiaries, ['companies/branch']);
	});

	test('double reference into one target works with distinct mirror names', () => {
		const T = coll('txn', { claim: { type: 'claims' }, reimburses_claim: { type: 'claims' } });
		const CL = coll('claim', {
			expense_transactions: { type: 'transactions', many: true, mirror_of: 'claim' },
			reimbursement_transactions: { type: 'transactions', many: true, mirror_of: 'reimburses_claim' },
		});
		const ws = workspace({ collections: { claims: CL, transactions: T } });
		assert.deepEqual([...compiledOf(ws, 'claims').compiled.mirrors].sort(), ['expense_transactions', 'reimbursement_transactions']);
	});
});


// ---- check, against the same cast ------------------------------------------------------------
// A mirror is DERIVED state: the owning side's reference is the truth, and the mirror is a cache of
// it. So check never asks "do both sides agree" — it recomputes what the owners imply and compares.
//
// ⚠ Every staleness case below is HAND-MADE, and has to be: the store maintains mirrors on add/set,
// so a workspace written through the tools is never stale. What check exists for is the state the
// tools cannot produce — a record hand-edited on one side, or a git merge that took one side of each
// file.
describe('check verifies mirrors', () => {
	test('a mirror the owning side has outgrown is flagged with the rebuild hint', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		// strip the mirror the store just wrote: the recording still claims the meeting, and the
		// meeting now carries no `recordings` at all
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
		const f = `${ws.root}/data/meetings/standup.meeting.md`;
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('recordings/cap1', 'recordings/ghost'));
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		// `recordings/ghost` is also a dangling reference; the staleness finding is the one under test
		assert.match(res.stdout, /recordings: stale — run: dreamteamer relations rebuild meetings/);
	});

	test('a mirror that matches the owning side is silent', () => {
		// the store writes exactly this mirror, so the assertion is that check and the store agree
		// about what a maintained mirror looks like — they read the same relation rows
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('add', 'recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		assert.match(readFile(ws.root, 'data/meetings/standup.meeting.md'), /recordings:\n  - recordings\/cap1/);
		const res = ws.dt('check');
		assert.equal(res.code, 0, res.stdout + res.stderr);
	});

	test('unique refuses two summaries for one meeting', () => {
		const ws = relWorkspace();
		ws.dt('add', 'meetings', '--name', 'Standup');
		assert.equal(ws.dt('add', 'summaries', '--name', 'One', '--meeting', 'meetings/standup').code, 0);
		// bypass the store to plant the duplicate, then check must catch it
		fs.writeFileSync(`${ws.root}/data/summaries/two.summary.md`, '---\nname: Two\nmeeting: meetings/standup\n---\n');
		const res = ws.dt('check');
		assert.equal(res.code, 1);
		assert.match(res.stdout, /meeting: "meetings\/standup" is already taken by summaries\/one \(unique\)/);
	});
});


// ---- presentation ------------------------------------------------------------------------------
// presentation is the ENGINE'S contract with every surface: the extension reads these rows and never
// the raw descriptors. A relation the compiler materializes but presentation does not project is a
// relation no UI can render as one — the mirror shows up as an ordinary editable reference list,
// which is exactly the field the store refuses to write.
describe('presentation projects relations', () => {
	test('the mirror row, the owner row, and the kind on the relation rows', () => {
		const ws = relWorkspace();
		const p = presentation(loadDescriptors(ws.root));

		const meetings = Object.fromEntries(p.fields.meetings.map((r) => [r.field, r]));
		assert.equal(meetings.recordings.kind, 'mirror');
		assert.equal(meetings.recordings.editable, false);
		assert.equal(meetings.recordings.mirror_of, 'meeting');
		assert.equal(meetings.recordings.role, 'mirror');
		assert.equal(meetings.recordings.many, true);
		// a unique owner's mirror is a SCALAR, and it is read-only just the same
		assert.equal(meetings.summary.kind, 'mirror');
		assert.equal(meetings.summary.editable, false);
		assert.equal(meetings.summary.mirror_of, 'meeting');
		assert.equal(meetings.summary.many, undefined);

		const recs = Object.fromEntries(p.fields.recordings.map((r) => [r.field, r]));
		assert.equal(recs.meeting.role, 'reference');
		assert.equal(recs.meeting.on_delete, 'restrict'); // the default, stated rather than implied
		assert.equal(recs.meeting.editable, true);        // the OWNER is the writable side
		assert.equal(recs.meeting.kind, undefined);
		const sums = Object.fromEntries(p.fields.summaries.map((r) => [r.field, r]));
		assert.equal(sums.meeting.unique, true);

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

describe('the body field — what a mirror target needs', () => {
	/** A `format: md` collection with no body field: nowhere for a record's prose to parse into, so
	 *  nowhere for a mirror write to put it back. coll() deliberately HAS one, which is why this case
	 *  has to be spelled out by hand. */
	const BODYLESS = {
		ids: { from: '{{ name | slug }}' },
		storage: { suffix: 'plain' },
		fields: { name: { type: 'string', required: true } },
	};
	const sourceOf = (ws) => load(readFile(ws.root, 'modules/default/collections/plain.collection.yaml'));

	test('add-field --body declares one, and a mirror onto the collection then compiles', () => {
		const ws = workspace({ collections: { plain: BODYLESS } });
		const add = ws.dt('add-field', 'plain', '--name', 'notes', '--type', 'markdown', '--body');
		assert.equal(add.code, 0, add.stderr);
		const d = sourceOf(ws);
		assert.equal(d.fields.notes.body, true, '--body has to write the key, not swallow the flag');

		d.fields.twins = { type: 'twins', many: true, mirror_of: 'twin' };
		fs.writeFileSync(`${ws.root}/modules/default/collections/plain.collection.yaml`, dump(d));
		fs.writeFileSync(`${ws.root}/modules/default/collections/twins.collection.yaml`, dump({ name: 'twins', ...coll('twin', { twin: { type: 'plain' } }) }));
		assert.equal(compileError(ws.ws), null);
	});

	test('a SECOND body is refused — a record has one', () => {
		const two = {
			...BODYLESS,
			fields: {
				name: { type: 'string', required: true },
				notes: { type: 'markdown', body: true },
				summary: { type: 'markdown', body: true },
			},
		};
		const err = compileError(workspace({ compile: false, collections: { plain: two } }).ws);
		assert.match(err, /2 fields declare body: true — a record has one body/);
	});

	test('--body on a field that cannot hold prose is refused, naming the type that can', () => {
		const ws = workspace({ collections: { plain: BODYLESS } });
		const res = ws.dt('add-field', 'plain', '--name', 'count', '--type', 'number', '--body');
		assert.notEqual(res.code, 0);
		assert.match(res.stderr + res.stdout, /--type markdown/);
	});

	test('a retype that says nothing about the body keeps it', () => {
		// `set-field --description` rebuilds the field from the flags alone, so an uncarried body
		// would silently un-body the field: the record's text then parses into nothing and the next
		// write serializes it away.
		const ws = workspace({ collections: { plain: BODYLESS } });
		assert.equal(ws.dt('add-field', 'plain', '--name', 'notes', '--type', 'markdown', '--body').code, 0);
		const res = ws.dt('set-field', 'plain', '--name', 'notes', '--description', 'what happened');
		assert.equal(res.code, 0, res.stderr);
		const d = sourceOf(ws);
		assert.equal(d.fields.notes.body, true);
		assert.equal(d.fields.notes.description, 'what happened');

		// …and --body false is how you deliberately clear it
		assert.equal(ws.dt('set-field', 'plain', '--name', 'notes', '--body', 'false').code, 0);
		assert.equal(sourceOf(ws).fields.notes.body, undefined);
	});
});
