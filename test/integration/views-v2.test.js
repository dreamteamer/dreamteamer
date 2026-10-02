// Tier 2 — ui-views and command-bindings in descriptor format v2, through a real compile, `dt next`
// and the orientation block.
//
// A clinic cut down to what the assertions need: `health/visits` with a display of its own, a view
// that changes some of it, a record-scope view, and a binding gated on the visit's status. Invented
// names only — this engine is published.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeCollection, compileError, compileQuietly, dt, readFile, WS_MODULE } from '../helpers/ws.js';
import { load, dump } from '../../src/yaml.js';

const VISITS = {
	description: 'One consultation.',
	ids: { from: '{{ reason | slug }}' },
	fields: {
		reason: { type: 'string', required: true },
		date: { type: 'date' },
		status: { type: 'string', default: 'booked', enum: ['booked', 'seen', 'cancelled'] },
		kind: { type: 'string', enum: ['intake', 'follow-up'] },
		prescribed: { type: 'boolean' },
		notes: { type: 'markdown', body: true },
	},
	display: {
		nav: { icon: 'pulse', order: 20 },
		list: { columns: ['reason', 'date', 'status'], sort: '-date', options: { page_size: 50 } },
		record: { subtitle: '{{ kind }}', badge: 'status' },
		form: { sections: [{ title: 'Visit', fields: ['reason', 'date', 'status'] }] },
	},
};

const TODAY = {
	name: 'today',
	title: 'Today',
	route: '/health/visits/today',
	scope: 'collection',
	collection: 'collections/health/visits',
	filter: { status: { _eq: 'booked' } },
	display: {
		nav: { title: 'Today', icon: 'calendar', order: 1 },
		list: { layout: 'kanban', options: { lanes_by: 'status', card_title: '{{ reason }}' } },
	},
};

function clinic({ views = {}, bindings = {}, visits = VISITS } = {}) {
	const w = workspace({ namespaces: ['health'], compile: false });
	writeCollection(w.root, 'health/visits', visits);
	const mod = path.join(w.root, 'modules', WS_MODULE);
	if (Object.keys(views).length) fs.mkdirSync(path.join(mod, 'ui-views'), { recursive: true });
	for (const [id, v] of Object.entries(views)) fs.writeFileSync(path.join(mod, 'ui-views', `${id}.ui-view.yaml`), typeof v === 'string' ? v : dump(v));
	if (Object.keys(bindings).length) {
		fs.mkdirSync(path.join(mod, 'command-bindings'), { recursive: true });
		fs.mkdirSync(path.join(mod, 'commands'), { recursive: true });
		fs.writeFileSync(path.join(mod, 'commands', 'prescribe.command.md'), '---\nname: prescribe\ndescription: Write the prescriptions for a visit.\n---\nWrite them.\n');
	}
	for (const [id, b] of Object.entries(bindings)) fs.writeFileSync(path.join(mod, 'command-bindings', `${id}.command-binding.yaml`), typeof b === 'string' ? b : dump(b));
	return w;
}
const compiledView = (root, id) => load(fs.readFileSync(path.join(root, '.dreamteamer', 'ui-views', `${id}.ui-view.yaml`), 'utf8'));

describe('a v2 ui-view', () => {
	test("its display merges over the collection's, key by key", () => {
		const w = clinic({ views: { today: TODAY } });
		assert.equal(compileError(w.ws), null);
		const { display } = compiledView(w.root, 'today').compiled;
		// list: the view's layout and options win; the collection's columns and sort are inherited
		assert.deepEqual(display.list, { columns: ['reason', 'date', 'status'], sort: '-date', layout: 'kanban', options: { lanes_by: 'status', card_title: '{{ reason }}' } });
		// a sub-block the view omits is the collection's, with the defaults compile supplied
		assert.deepEqual(display.record, { layout: 'page', ...VISITS.display.record });
		assert.deepEqual(display.form, VISITS.display.form);
		// nav: the view's keys over the collection's
		assert.deepEqual(display.nav, { icon: 'calendar', order: 1, title: 'Today' });
	});

	test('the compiled view is the source plus one `compiled` block', () => {
		const w = clinic({ views: { today: TODAY } });
		compileQuietly(w.ws);
		const { compiled, ...rest } = compiledView(w.root, 'today');
		assert.deepEqual(rest, TODAY);
		assert.deepEqual(Object.keys(compiled), ['display']);
	});

	test('a view with no nav has no nav entry — the collection\'s is not inherited', () => {
		const { nav, ...noNav } = TODAY.display;
		const w = clinic({ views: { today: { ...TODAY, display: noNav } } });
		compileQuietly(w.ws);
		assert.equal(compiledView(w.root, 'today').compiled.display.nav, undefined);
	});

	test('a record-scope view resolves its record page over the collection\'s', () => {
		const w = clinic({ views: { chart: { route: '/health/visits/chart', scope: 'record', collection: 'collections/health/visits', display: { record: { layout: 'chart', options: { start: 'date' } } } } } });
		assert.equal(compileError(w.ws), null);
		const { display } = compiledView(w.root, 'chart').compiled;
		assert.deepEqual(display.record, { subtitle: '{{ kind }}', badge: 'status', layout: 'chart', options: { start: 'date' } });
		assert.deepEqual(display.list, { layout: 'table', ...VISITS.display.list }, 'the list is the collection\'s, default layout included');
	});

	test('`default` on a v2 view fails compile, naming the collection\'s display as the default view', () => {
		const w = clinic({ views: { visits: { route: '/health/visits', scope: 'collection', collection: 'collections/health/visits', default: true } } });
		const err = compileError(w.ws);
		assert.match(err, /visits\.ui-view\.yaml/);
		assert.match(err, /`default` — a view is always a named variant; the collection's own `display` is its default view/);
	});

	test('a v1 view is refused with the converter command and UPDATING.md', () => {
		const w = clinic({ views: { old: 'path: /old\ntarget: list\ncollection: collections/health/visits\nlayout: table\n' } });
		const err = compileError(w.ws);
		assert.match(err, /in the v1 descriptor format[^]*- modules\/default\/ui-views\/old\.ui-view\.yaml/);
		assert.match(err, /node node_modules\/dreamteamer\/scripts\/migrate-descriptors-v2\.mjs --root \./);
		assert.match(err, /UPDATING\.md/);
	});

	test('a key outside the closed list is named', () => {
		const w = clinic({ views: { today: { ...TODAY, layout: 'kanban' } } });
		assert.match(compileError(w.ws), /unknown key `layout` — a ui-view's keys are name · title · description · route · scope · collection · filter · display/);
	});

	// rule 6: every name a view mentions must be a field of its collection
	for (const [what, patch, position] of [
		['a column', { list: { columns: ['reason', 'ghost'] } }, /display\.list\.columns names "ghost"/],
		['a sort', { list: { sort: '-ghost' } }, /display\.list\.sort names "-ghost"/],
		['a field option', { list: { options: { lanes_by: 'ghost' } } }, /display\.list\.options\.lanes_by names "ghost"/],
		['a template option', { list: { options: { card_title: '{{ ghost }}' } } }, /display\.list\.options\.card_title: "\{\{ ghost \}\}" is not a field/],
		['a badge', { record: { badge: 'ghost' } }, /display\.record\.badge names "ghost"/],
	]) {
		test(`a dangling field in ${what} fails compile naming the position`, () => {
			const w = clinic({ views: { today: { ...TODAY, display: patch } } });
			assert.match(compileError(w.ws), position);
		});
	}

	test('a dangling field in the filter fails compile naming it', () => {
		const w = clinic({ views: { today: { ...TODAY, filter: { ghost: { _eq: 1 } } } } });
		assert.match(compileError(w.ws), /filter names "ghost", which is not a field of collections\/health\/visits/);
	});
});

describe('a v2 command-binding', () => {
	const PRESCRIBE = {
		command: 'commands/prescribe',
		collection: 'collections/health/visits',
		scope: 'record',
		available_when: { status: { _eq: 'seen' } },
		done_when: { prescribed: { _eq: true } },
		description: 'Write the prescriptions for a visit that has been seen.',
	};

	test('dt next reads available_when and done_when per record', () => {
		const w = clinic({ bindings: { 'prescribe--visits': PRESCRIBE } });
		assert.equal(dt(w.root, 'compile').code, 0);
		for (const [reason, status, prescribed] of [['Cough', 'booked'], ['Rash', 'seen'], ['Fever', 'seen', 'true']]) {
			assert.equal(dt(w.root, 'add', 'health/visits', '--reason', reason, '--status', status, ...(prescribed ? ['--prescribed', prescribed] : [])).code, 0);
		}
		const state = (id) => {
			const out = JSON.parse(dt(w.root, 'next', `health/visits/${id}`, '--json').stdout).commands[0];
			assert.equal(out.scope, 'record');
			return out.states[id];
		};
		assert.equal(state('cough'), 'not-applicable');
		assert.equal(state('rash'), 'available');
		assert.equal(state('fever'), 'done');
	});

	test('the orientation block renders both gates', () => {
		const w = clinic({ bindings: { 'prescribe--visits': PRESCRIBE } });
		assert.equal(dt(w.root, 'compile').code, 0);
		assert.match(readFile(w.root, 'CLAUDE.md'), /- health\/visits — \/prescribe \(available when: status=seen · done when: prescribed=true\)/);
	});

	test('a v1 binding is refused with the converter command', () => {
		const w = clinic({ bindings: { 'prescribe--visits': 'command: commands/prescribe\ncollection: collections/health/visits\ntarget: record\ncan-enter:\n  status:\n    _eq: seen\n' } });
		const err = compileError(w.ws);
		assert.match(err, /in the v1 descriptor format[^]*- modules\/default\/command-bindings\/prescribe--visits\.command-binding\.yaml/);
		assert.match(err, /node node_modules\/dreamteamer\/scripts\/migrate-descriptors-v2\.mjs --root \./);
	});

	test('a condition naming a field the collection lacks fails compile naming it', () => {
		const w = clinic({ bindings: { 'prescribe--visits': { ...PRESCRIBE, done_when: { ghost: { _nempty: true } } } } });
		assert.match(compileError(w.ws), /done_when names "ghost", which is not a field of collections\/health\/visits/);
	});

	test('an unknown operator is refused', () => {
		const w = clinic({ bindings: { 'prescribe--visits': { ...PRESCRIBE, available_when: { status: { _eqq: 'seen' } } } } });
		assert.match(compileError(w.ws), /available_when has unknown filter operator\(s\) _eqq/);
	});

	test('a condition on a collection-scope binding warns that nothing reads it', () => {
		const w = clinic({ bindings: { 'prescribe--visits': { ...PRESCRIBE, scope: 'collection' } } });
		const { warnings } = compileQuietly(w.ws);
		assert.match(warnings.join('\n'), /available_when is read by nothing — a collection-scope binding evaluates no record/);
	});
});
