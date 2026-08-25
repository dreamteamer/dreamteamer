// the YAML contract, pinned — because src/yaml.js is the ONE parser every record, descriptor and
// manifest goes through, and the library behind it changed (js-yaml → eemeli yaml in 0.14). Two
// kinds of pin: the CORE-schema semantics the engine has always promised, and CROSS-PARSE agreement
// with js-yaml, which the VS Code extension still uses for its pre-activation reads — a value this
// dump writes must mean the same thing to both readers.
import test from 'node:test';
import assert from 'node:assert/strict';
import jsyaml from 'js-yaml';
import { load, dump, parseDoc, stringifyDoc } from '../../src/yaml.js';

test('unquoted dates and date-times stay STRINGS, never Date objects', () => {
	const v = load('d: 2026-07-28\nt: 2026-07-28T12:00:00+03:00\nz: 2026-07-28T09:00:00Z\n');
	for (const k of ['d', 't', 'z']) assert.equal(typeof v[k], 'string', `${k} must be a string`);
	assert.equal(v.t, '2026-07-28T12:00:00+03:00');
});

test('YAML 1.2 core: on/yes/no are strings, true/false are booleans', () => {
	const v = load('a: on\nb: yes\nc: no\nd: true\ne: false\n');
	assert.deepEqual(v, { a: 'on', b: 'yes', c: 'no', d: true, e: false });
});

test('empty input is nullish (parseRecordText relies on `?? {}`)', () => {
	assert.equal(load('') ?? null, null);
});

test('dump quotes what must round-trip as a string, single-quote style', () => {
	const out = dump({ n: '123', b: 'true', colon: 'a: colon value', empty: '' });
	assert.match(out, /n: '123'/);
	assert.match(out, /b: 'true'/);
	assert.match(out, /colon: 'a: colon value'/);
	assert.match(out, /empty: ''/);
});

test('dump omits undefined values and emits no anchors for shared objects', () => {
	const shared = { x: 1 };
	const out = dump({ gone: undefined, a: shared, b: shared });
	assert.doesNotMatch(out, /gone/);
	assert.doesNotMatch(out, /&/); // aliasDuplicateObjects: false
});

test('CROSS-PARSE: everything this dump writes reads back identically through js-yaml CORE_SCHEMA', () => {
	// representative record frontmatter: strings that look like other types, offset date-times,
	// arrays, nested maps, numbers — the shapes real records carry
	const fields = {
		title: 'Review with acme', status: 'open', starts: '2026-07-28T12:00:00+03:00',
		due: '2026-08-01', amount: 2083.5, count: 3, done: false,
		tags: ['a', 'b'], nested: { k: 'v', n: 1 }, weird: 'yes', num: '007', note: 'a: b',
	};
	const text = dump(fields);
	assert.deepEqual(jsyaml.load(text, { schema: jsyaml.CORE_SCHEMA }), fields, 'js-yaml CORE must agree');
	assert.deepEqual(load(text), fields, 'own round-trip must agree');
});

test('CROSS-PARSE: what js-yaml wrote before the swap reads back identically here', () => {
	const fields = { starts: '2026-07-28T12:00:00+03:00', q: "it's", multi: 'one\ntwo', tags: ['x'] };
	assert.deepEqual(load(jsyaml.dump(fields, { lineWidth: 120 })), fields);
});

// ---- parseDoc: the capability the swap exists for ------------------------------------------------

const DESCRIPTOR = `name: meetings
# the storage line is FLOW on purpose — the edit must not reformat it
storage: { path: meetings, codec: md, shape: file, suffix: meeting }
schema:
  type: object
  required: [title]
  properties:
    title:
      type: string
    # why this field exists: the reasoning a load→dump write used to destroy
    status:
      type: string
`;

test('parseDoc edit preserves comments, flow style and untouched lines', () => {
	const doc = parseDoc(DESCRIPTOR);
	doc.setIn(['schema', 'properties', 'owner'], { type: 'string' });
	const out = stringifyDoc(doc);
	assert.match(out, /# the storage line is FLOW on purpose/);
	assert.match(out, /# why this field exists/);
	assert.match(out, /storage: \{ path: meetings, codec: md, shape: file, suffix: meeting \}/);
	assert.match(out, /owner:\n {6}type: string/);
	assert.deepEqual(load(out).schema.required, ['title']);
});

test('parseDoc deleteIn removes a field, its neighbours and their comments intact', () => {
	const doc = parseDoc(DESCRIPTOR);
	doc.deleteIn(['schema', 'properties', 'status']);
	const out = stringifyDoc(doc);
	assert.doesNotMatch(out, /status/);
	assert.match(out, /title:\n {6}type: string/);
	assert.match(out, /# the storage line is FLOW on purpose/);
});

test('a required seq edited in place keeps its flow style', () => {
	const doc = parseDoc(DESCRIPTOR);
	doc.getIn(['schema', 'required'], true).add('status');
	assert.match(stringifyDoc(doc), /required: \[ title, status \]/);
});
