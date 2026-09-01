// The source round-trip seam — `writeSource` keeps everything a change did not touch.
//
// This is the reproduction the comment in src/yaml.js cites. The fixture is the shape a real module
// source has: a file header, a comment above a NESTED property, an inline flow sequence, an inline
// flow mapping, a trailing comment (single- and multi-line), and a hand-folded block scalar. Every
// one of those was destroyed or reflowed by the `load` → mutate → `dump` path this replaces.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { load, dump, writeSource, commentCount } from '../../src/yaml.js';

/** A descriptor carrying every construct the old write path damaged. */
const DESCRIPTOR = `# THINGS — this header is why the collection exists, and it is the whole reason
# a module source may not be re-serialized from its parsed value.
name: things
templates: [provenance]
storage: { path: data/things, suffix: thing }
order: 15   # immediately after summaries (14) — it is the layer above it
icon: star            # not \`lightbulb\` — blurbs already owns that glyph, and two
                      # identical icons in one nav is the same failure as no icon
list_fields: [name, status]
schema:
  type: object
  required: [name]
  properties:
    name:
      type: string
    # the importer keys on this — renaming it breaks every inbound feed, so it is
    # spelled the way the upstream spells it rather than the way we would
    external_id:
      type: string
      description: >-
        The id the upstream system knows this by, hand-wrapped at a width the
        author chose and no writer may re-derive.
    body:
      type: string
      format: markdown
      x-body: true
`;

const linesOf = (t) => t.split('\n');
/** The lines present in `a` and absent from `b` — what a write LOST. */
const lost = (a, b) => { const s = new Set(linesOf(b)); return linesOf(a).filter((l) => !s.has(l)); };
const gained = (a, b) => lost(b, a);

describe('writeSource — parse semantics match the CORE schema `load` uses', () => {
	// src/yaml.js exists so an unquoted date stays a string. The round-trip writer parses with the
	// `yaml` package instead of js-yaml, so the two MUST agree or a rewrite would retype a value.
	const CASES = `date: 2026-08-12
starts: 2026-08-12T09:00:00
version: 1.2.3
nope: no
yes_: yes
on_: on
id: 42
ratio: 1.5
quoted: '2026-08-12'
`;
	test('both parsers agree on every value the engine cares about', () => {
		const viaLoad = load(CASES);
		// writeSource with an unchanged value must not alter a single byte — which is only true if its
		// own parse produced exactly the same values
		assert.equal(writeSource(CASES, viaLoad), CASES);
	});

	test('an unquoted date, timestamp and version stay STRINGS', () => {
		const v = load(CASES);
		for (const k of ['date', 'starts', 'version', 'nope', 'yes_', 'on_', 'quoted']) {
			assert.equal(typeof v[k], 'string', `${k} parsed as ${typeof v[k]}, not a string`);
		}
		assert.equal(typeof v.id, 'number');
		assert.equal(typeof v.ratio, 'number');
	});
});

describe('writeSource — an unchanged value is byte-identical', () => {
	test('a no-op write returns the source unaltered', () => {
		assert.equal(writeSource(DESCRIPTOR, load(DESCRIPTOR)), DESCRIPTOR);
	});

	test('a null previousText dumps, exactly as a brand-new file always did', () => {
		const v = { name: 'things', order: 1 };
		assert.equal(writeSource(null, v), dump(v));
	});
});

describe('writeSource — a mutation changes ONLY what it mutates', () => {
	test('adding a field leaves every other byte alone', () => {
		const out = writeSource(DESCRIPTOR, (() => {
			const d = load(DESCRIPTOR);
			// insert before the x-body field, as upsertField does
			const props = {};
			for (const [k, v] of Object.entries(d.schema.properties)) {
				if (k === 'body') props.tags = { type: 'array', items: { type: 'string' } };
				props[k] = v;
			}
			d.schema.properties = props;
			return d;
		})());
		assert.deepEqual(lost(DESCRIPTOR, out), [], 'a line was lost that the mutation never named');
		assert.deepEqual(gained(DESCRIPTOR, out), ['    tags:', '      type: array', '      items:', '        type: string']);
	});

	test('add then remove is byte-identical — the net-zero probe that found the original bug', () => {
		const added = writeSource(DESCRIPTOR, (() => {
			const d = load(DESCRIPTOR);
			d.schema.properties = { tags: { type: 'array' }, ...d.schema.properties };
			return d;
		})());
		assert.notEqual(added, DESCRIPTOR);
		const back = writeSource(added, (() => {
			const d = load(added);
			delete d.schema.properties.tags;
			return d;
		})());
		assert.equal(back, DESCRIPTOR);
	});

	test('a NESTED comment survives — the limit the textual workaround could not pass', () => {
		const out = writeSource(DESCRIPTOR, (() => {
			const d = load(DESCRIPTOR);
			d.schema.properties.status = { type: 'string' };
			return d;
		})());
		assert.match(out, /# the importer keys on this/);
		assert.match(out, /# spelled the way the upstream spells it/);
		assert.equal(commentCount(out), commentCount(DESCRIPTOR));
	});

	test('the file header, the flow forms and the hand-folded scalar all survive an edit', () => {
		const out = writeSource(DESCRIPTOR, (() => {
			const d = load(DESCRIPTOR);
			d.order = 16;
			return d;
		})());
		assert.match(out, /^# THINGS — this header is why the collection exists/);
		assert.match(out, /^templates: \[provenance\]$/m, 'an inline flow sequence was expanded');
		assert.match(out, /^storage: \{ path: data\/things, suffix: thing \}$/m, 'an inline flow mapping was expanded');
		assert.match(out, /^ {8}The id the upstream system knows this by, hand-wrapped at a width the$/m, 'a hand-folded scalar was re-wrapped');
		assert.match(out, /^icon: star {12}# not `lightbulb`/m, 'a trailing comment lost its alignment');
		assert.match(out, /^ {22}# identical icons in one nav/m, 'a multi-line trailing comment lost a line');
		// the value changed, so its line is re-emitted and the comment's hand-alignment goes with it —
		// the ONE line the edit named, and nothing else in the file
		assert.deepEqual(gained(DESCRIPTOR, out), ['order: 16 # immediately after summaries (14) — it is the layer above it']);
	});

	test('a scalar deep inside the schema changes on its own line only', () => {
		const out = writeSource(DESCRIPTOR, (() => {
			const d = load(DESCRIPTOR);
			d.schema.properties.name.type = 'integer';
			return d;
		})());
		assert.deepEqual(lost(DESCRIPTOR, out), []);
		assert.deepEqual(gained(DESCRIPTOR, out), ['      type: integer']);
	});

	test('an x-reference retarget rewrites the reference and nothing else', () => {
		const src = `# why this collection points where it does
name: visits
schema:
  properties:
    doctor:
      type: string
      x-reference: doctors
    others: { type: array, items: { type: string, x-reference: doctors } }
    tags: [a, b]
`;
		const out = writeSource(src, (() => {
			const d = load(src);
			d.schema.properties.doctor['x-reference'] = 'health/doctors';
			d.schema.properties.others.items['x-reference'] = 'health/doctors';
			return d;
		})());
		assert.match(out, /^# why this collection points where it does$/m);
		assert.match(out, /^ {6}x-reference: health\/doctors$/m);
		// the inline flow form is the one the old textual retarget failed on
		assert.match(out, /^ {4}others: \{type: array, items: \{type: string, x-reference: health\/doctors\}\}$/m);
		assert.match(out, /^ {4}tags: \[a, b\]$/m);
		assert.equal(load(out).schema.properties.others.items['x-reference'], 'health/doctors');
	});

	test('a list loses one entry without disturbing the rest of the file', () => {
		const out = writeSource(DESCRIPTOR, (() => {
			const d = load(DESCRIPTOR);
			d.list_fields = ['name'];
			return d;
		})());
		assert.deepEqual(gained(DESCRIPTOR, out), ['list_fields: [name]']); // unpadded, as every flow sequence in a real corpus is
	});
});

describe('writeSource — a comment in a LIST stays on the item it explains', () => {
	// ⚠ Index-matching a sequence hands a comment to whatever slides into that slot. Dropping the
	// first entry of `required: [name, vendor_code]` moved "name is required because…" on top of
	// `vendor_code` — an explanation attached to something it does not explain, which is worse than
	// losing it. Items are matched by VALUE first for exactly this reason.
	const LIST = `required:
  # explains the list as a whole — the parser attaches a first-position comment to the SEQUENCE
  - name
  # explains vendor_code specifically
  - vendor_code
  - colour
`;

	test('removing a commented entry takes its comment with it', () => {
		const v = load(LIST);
		v.required = ['name', 'colour'];
		const out = writeSource(LIST, v);
		assert.doesNotMatch(out, /explains vendor_code specifically/);
		assert.match(out, /# explains the list as a whole/, 'the sequence-level comment is not the item\'s');
		assert.deepEqual(load(out).required, ['name', 'colour']);
	});

	test('inserting an entry does not shift any comment onto a different item', () => {
		const v = load(LIST);
		v.required = ['name', 'shape', 'vendor_code', 'colour'];
		const out = writeSource(LIST, v);
		assert.match(out, /# explains vendor_code specifically\n {2}- vendor_code/, 'the comment followed its item past the insertion');
	});

	test('an in-place edit KEEPS the comment on that position — the retarget case', () => {
		const src = `about:
  x-reference:
    # the clinic side of the join
    - doctors
    - clients
`;
		const v = load(src);
		v.about['x-reference'] = ['health/doctors', 'clients'];
		const out = writeSource(src, v);
		assert.match(out, /# the clinic side of the join\n {4}- health\/doctors/);
	});
});

describe('writeSource — it fails closed rather than writing something wrong', () => {
	test('the value written is always exactly the value asked for', () => {
		const v = load(DESCRIPTOR);
		v.schema.properties.external_id.description = 'a short one now';
		v.storage.suffix = 'item';
		v.templates = ['provenance', 'docs'];
		assert.deepEqual(load(writeSource(DESCRIPTOR, v)), v);
	});

	test('a whole subtree replaced by a different shape still round-trips its value', () => {
		const v = load(DESCRIPTOR);
		v.storage = 'not-a-map-any-more';
		assert.equal(load(writeSource(DESCRIPTOR, v)).storage, 'not-a-map-any-more');
	});
});

describe('commentCount', () => {
	test('counts comment lines wherever they are indented', () => {
		assert.equal(commentCount(DESCRIPTOR), 5);
		assert.equal(commentCount('a: 1\n'), 0);
		assert.equal(commentCount('a: 1 # trailing does not count as its own line\n'), 0);
	});
});
