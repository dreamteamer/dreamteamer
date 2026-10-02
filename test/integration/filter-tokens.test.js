// Tier 2 — $today and $now in --where, a view filter and a binding condition; any other $token is
// refused before it can narrow anything to nothing. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, writeCollection, compileError, compileQuietly, dt, WS_MODULE } from '../helpers/ws.js';
import { dump } from '../../src/yaml.js';

const VISITS = { description: 'A visit.', ids: { from: '{{ name | slug }}' }, fields: { name: { type: 'string', required: true }, day: { type: 'date' }, notes: { type: 'markdown', body: true } } };
const today = () => { const t = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`; };

test('--where with $today lists today\'s rows; an unknown token is refused', () => {
	const w = workspace({ compile: false });
	writeCollection(w.root, 'visits', VISITS);
	compileQuietly(w.ws);
	dt(w.root, 'add', 'visits', '--name', 'Now', '--day', today());
	dt(w.root, 'add', 'visits', '--name', 'Old', '--day', '2020-01-01');
	const r = dt(w.root, 'list', 'visits', '--where', JSON.stringify({ day: { _eq: '$today' } }), '--json');
	assert.equal(r.code, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout).map((x) => x.id), ['now']);
	const bad = dt(w.root, 'list', 'visits', '--where', JSON.stringify({ day: { _eq: '$yesterday' } }));
	assert.notEqual(bad.code, 0);
	assert.match(bad.stderr, /unknown value token\(s\) \$yesterday/);
});

test('a view filter with an unknown token fails compile', () => {
	const w = workspace({ compile: false });
	writeCollection(w.root, 'visits', VISITS);
	const dir = path.join(w.root, 'modules', WS_MODULE, 'ui-views');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'today.ui-view.yaml'), dump({ route: '/visits/today', scope: 'collection', collection: 'collections/visits', filter: { day: { _eq: '$yesterday' } } }));
	assert.match(compileError(w.ws), /filter holds unknown value token\(s\) \$yesterday/);
});
