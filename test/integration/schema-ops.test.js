// Tier 2 — the meta verbs, through the CLI, including the namespace flag.
//
// These write SOURCES behind a real compile gate, which is the property worth testing: a schema op
// that produced an uncompilable descriptor used to be discoverable only on the next command.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, simpleCollection, readFile } from '../helpers/ws.js';
import { load } from '../../src/yaml.js';

const descriptorOf = (ws, file) => load(readFile(ws.root, file));

describe('collections add', () => {
	test('creates a compilable collection in the default namespace', () => {
		const ws = workspace();
		const res = ws.dt('schema', 'add-collection', '--name', 'widgets');
		assert.equal(res.code, 0, res.stderr);

		const d = descriptorOf(ws, 'modules/default/collections/widgets.collection.yaml');
		assert.equal(d.name, 'widgets');
		assert.equal(d.storage.path, 'data/widgets');
		assert.equal(d.storage.suffix, 'widget');
		assert.equal(ws.dt('add', 'widgets', '--name', 'A').code, 0);
		assert.ok(readFile(ws.root, 'data/widgets/a.widget.md'));
	});

	test('--namespace puts it in the namespace folder with a bare suffix', () => {
		const ws = workspace({ namespaces: ['health'] });
		const res = ws.dt('schema', 'add-collection', '--namespace', 'health', '--name', 'doctors');
		assert.equal(res.code, 0, res.stderr);

		const d = descriptorOf(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.equal(d.name, 'health/doctors');
		assert.equal(d.storage.path, 'data/health/doctors');
		// the suffix comes off the BARE name — `<id>.doctor.md`, never `<id>.health/doctor.md`
		assert.equal(d.storage.suffix, 'doctor');
	});

	test('a qualified --name is the same thing as --namespace', () => {
		const ws = workspace({ namespaces: ['health'] });
		assert.equal(ws.dt('schema', 'add-collection', '--name', 'health/doctors').code, 0);
		const d = descriptorOf(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.equal(d.name, 'health/doctors');
		assert.equal(d.storage.path, 'data/health/doctors');
	});

	test('an undeclared namespace is refused BEFORE a file is written', () => {
		const ws = workspace();
		const res = ws.dt('schema', 'add-collection', '--name', 'health/doctors');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /"health" is not declared/);
		assert.equal(readFile(ws.root, 'modules/default/collections/health/doctors.collection.yaml'), null);
	});

	test('a duplicate name is refused', () => {
		const ws = workspace({ namespaces: ['health'] });
		assert.equal(ws.dt('schema', 'add-collection', '--name', 'health/doctors').code, 0);
		const again = ws.dt('schema', 'add-collection', '--name', 'health/doctors');
		assert.equal(again.code, 1);
		assert.match(again.stderr, /already exists/);
	});
});

describe('collections rm', () => {
	test('removes a namespaced collection', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('schema', 'add-collection', '--name', 'health/doctors');
		const res = ws.dt('schema', 'rm-collection', 'health/doctors');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(readFile(ws.root, 'modules/default/collections/health/doctors.collection.yaml'), null);
	});

	test('refuses while records exist, and --force overrides', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('schema', 'add-collection', '--name', 'health/doctors');
		ws.dt('add', 'health/doctors', '--name', 'Dana');
		const refused = ws.dt('schema', 'rm-collection', 'health/doctors');
		assert.equal(refused.code, 1);
		assert.match(refused.stderr, /still has records/);
		assert.equal(ws.dt('schema', 'rm-collection', 'health/doctors', '--force').code, 0);
	});
});

describe('field verbs on a namespaced collection', () => {
	test('add-field, update-field and remove-field all address it by qualified name', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('schema', 'add-collection', '--name', 'health/doctors');

		assert.equal(ws.dt('schema', 'add-field', 'health/doctors', '--name', 'speciality', '--type', 'string').code, 0);
		let d = descriptorOf(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.equal(d.schema.properties.speciality.type, 'string');

		assert.equal(
			ws.dt('schema', 'update-field', 'health/doctors', '--name', 'speciality', '--type', 'enum', '--options', 'gp,ent').code,
			0,
		);
		d = descriptorOf(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.deepEqual(d.schema.properties.speciality.enum, ['gp', 'ent']);

		assert.equal(ws.dt('schema', 'remove-field', 'health/doctors', '--name', 'speciality').code, 0);
		d = descriptorOf(ws, 'modules/default/collections/health/doctors.collection.yaml');
		assert.equal(d.schema.properties.speciality, undefined);
	});

	test('a reference field can target a namespaced collection', () => {
		const ws = workspace({ namespaces: ['health'] });
		ws.dt('schema', 'add-collection', '--name', 'health/doctors');
		ws.dt('schema', 'add-collection', '--name', 'health/visits');
		const res = ws.dt('schema', 'add-field', 'health/visits', '--name', 'doctor', '--type', 'reference', '--target', 'health/doctors');
		assert.equal(res.code, 0, res.stderr);

		ws.dt('add', 'health/doctors', '--name', 'Dana Levi');
		assert.equal(ws.dt('add', 'health/visits', '--name', 'v1', '--doctor', 'health/doctors/dana-levi').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});
});

// ---- relation authoring flags ------------------------------------------------------------------
// A two-way relation is one line of YAML, and until these flags existed you had to know which line
// and which of the three source spellings to write it in. The load-bearing case is the LAST group:
// `update-field` rebuilds the prop from `fieldDef`, so an update that only touches a description
// used to silently turn a foreign key into a plain string and orphan the mirror on the other side.
describe('relation authoring flags', () => {
	function bare() {
		return workspace({ collections: {
			meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
			'meeting-recordings': simpleCollection({ storage: { suffix: 'recording' } }),
		} });
	}
	const sourceOf = (ws, c) => load(readFile(ws.root, `modules/default/collections/${c}.collection.yaml`));
	const compiledOf = (ws, c) => load(readFile(ws.root, `.dreamteamer/collections/${c}.collection.yaml`));

	test('--inverse derives the default mirror name (strip singular(target)-, then singularize if unique)', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /mirror: meetings\.recordings\[\]/);
		assert.equal(compiledOf(ws, 'meetings').schema.properties.recordings.items['x-inverse-of'], 'meeting-recordings.meeting');
	});

	test('--unique makes the mirror scalar and singular', () => {
		const ws = workspace({ collections: {
			meetings: simpleCollection({ storage: { suffix: 'meeting' } }),
			'meeting-summaries': simpleCollection({ storage: { suffix: 'summary' } }),
		} });
		const res = ws.dt('schema', 'add-field', 'meeting-summaries', '--name', 'meeting', '--type', 'meetings', '--inverse', '--unique');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /mirror: meetings\.summary\b/);
		assert.equal(sourceOf(ws, 'meeting-summaries').schema.properties.meeting['x-unique'], true);
		assert.equal(compiledOf(ws, 'meetings').schema.properties.summary.type, 'string');
	});

	test('--on-delete lands on the holder', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse', '--on-delete', 'set-null');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(sourceOf(ws, 'meeting-recordings').schema.properties.meeting['x-on-delete'], 'set-null');
	});

	test('--many builds an array of references', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'refs', '--type', 'meetings', '--many');
		assert.equal(res.code, 0, res.stderr);
		const refs = compiledOf(ws, 'meeting-recordings').schema.properties.refs;
		assert.equal(refs.type, 'array');
		assert.equal(refs.items['x-reference'], 'meetings');
	});

	test('--many --inverse is a many-to-many: an array FK with an array mirror', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meetings', '--type', 'meetings', '--many', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		const fk = sourceOf(ws, 'meeting-recordings').schema.properties.meetings;
		assert.equal(fk.type, 'array');
		assert.equal(fk.items['x-inverse'], 'recordings');
		const mirror = compiledOf(ws, 'meetings').schema.properties.recordings;
		assert.equal(mirror.type, 'array');
		assert.equal(mirror.items['x-inverse-of'], 'meeting-recordings.meetings');
	});

	test('--mirror-of declares spelling B from the side being edited', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings');
		const res = ws.dt('schema', 'add-field', 'meetings', '--name', 'recordings', '--many', '--type', 'meeting-recordings', '--mirror-of', 'meeting-recordings.meeting');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(compiledOf(ws, 'meetings').schema.properties.recordings.items['x-inverse-of'], 'meeting-recordings.meeting');
	});

	test('update-field without relation flags PRESERVES the relation keywords', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--description', 'the call this captures');
		assert.equal(res.code, 0, res.stderr);
		const meeting = sourceOf(ws, 'meeting-recordings').schema.properties.meeting;
		assert.equal(meeting['x-reference'], 'meetings');
		assert.equal(meeting['x-inverse'], 'recordings');
		assert.equal(meeting.description, 'the call this captures');
	});

	test('update-field --inverse adds a mirror to an EXISTING foreign key', () => {
		// The migration path: a plain FK written before relations existed gains its mirror without
		// restating --type. fieldDef alone cannot resolve this — the target only arrives with the
		// carry-forward — and the first cut refused it outright.
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		assert.equal(sourceOf(ws, 'meeting-recordings').schema.properties.meeting['x-inverse'], 'recordings');
		assert.equal(compiledOf(ws, 'meetings').schema.properties.recordings.items['x-inverse-of'], 'meeting-recordings.meeting');
	});

	test('records that already carry the key are counted, with the rebuild that repairs them', () => {
		const ws = bare();
		ws.dt('add', 'meetings', '--name', 'Standup');
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings');
		ws.dt('add', 'meeting-recordings', '--name', 'Cap1', '--meeting', 'meetings/standup');
		ws.dt('add', 'meeting-recordings', '--name', 'Cap2', '--meeting', 'meetings/standup');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--inverse');
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /2 meeting-recordings records carry values — run: dreamteamer relations rebuild meetings/);
		// and the hint is not decoration: check says the same thing about the same records
		assert.equal(ws.dt('check').code, 1);
		assert.equal(ws.dt('relations', 'rebuild', 'meetings').code, 0);
		assert.equal(ws.dt('check').code, 0);
	});

	test('--inverse on a field that references nothing is refused, not silently ignored', () => {
		const ws = bare();
		const res = ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'quality', '--type', 'string', '--inverse');
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--inverse needs a single-collection/);
	});

	test('update-field --inverse "" drops the mirror', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'meeting', '--type', 'meetings', '--inverse');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'meeting', '--inverse=');
		assert.equal(res.code, 0, res.stderr);
		const meeting = sourceOf(ws, 'meeting-recordings').schema.properties.meeting;
		assert.equal(meeting['x-inverse'], undefined);
		assert.equal(meeting['x-reference'], 'meetings'); // the reference survives; only the mirror goes
		assert.equal(compiledOf(ws, 'meetings').schema.properties.recordings, undefined);
	});

	test('update-field on a NON-relation field is unchanged — no relation keywords appear', () => {
		const ws = bare();
		ws.dt('schema', 'add-field', 'meeting-recordings', '--name', 'quality', '--type', 'string', '--description', 'how clean the audio is');
		const res = ws.dt('schema', 'update-field', 'meeting-recordings', '--name', 'quality', '--type', 'enum', '--options', 'clear,noisy');
		assert.equal(res.code, 0, res.stderr);
		const quality = sourceOf(ws, 'meeting-recordings').schema.properties.quality;
		assert.deepEqual(quality.enum, ['clear', 'noisy']);
		assert.equal(quality.description, 'how clean the audio is'); // the pre-existing carry still works
		assert.deepEqual(Object.keys(quality).filter((k) => k.startsWith('x-')), []);
	});
});
