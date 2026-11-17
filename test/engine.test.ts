import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DtError, add, buildModel, check, compile, get, listIds, rm, set } from '../src/api.ts';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dt-fp-'));
  const put = (p: string, text: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); };
  put('package.json', JSON.stringify({ name: 'ws', dependencies: { people: '1.0.0' }, dreamteamer: {} }));
  put('node_modules/people/package.json', JSON.stringify({ name: 'people', version: '1.0.0', dreamteamer: { extension: './x.mjs' } }));
  put('node_modules/people/mixins/entity.mixin.yaml', 'name: entity\nids: {from: "{{ name | slug }}", pattern: "^[a-z0-9-]+$"}\nfields:\n  name: {type: string, required: true}\n  notes: {type: markdown, body: true}\n');
  put('node_modules/people/collections/users.collection.yaml', 'name: users\nmixins: [entity]\nstorage: {path: data/users, format: md}\nfields:\n  kind: {type: string, default: person, enum: [person, agent]}\n');
  put('modules/local/package.json', JSON.stringify({ name: 'local', version: '0.0.1', dreamteamer: {} }));
  put('modules/local/collections/tasks.collection.yaml', 'name: tasks\nstorage: {path: data/tasks, format: md}\nids: {from: "{{ created | date }}--{{ name | slug }}"}\nfields:\n  name: {type: string, required: true}\n  assignee: {type: users}\n  about: {type: [users, ghosts]}\n  ghost: {type: ghosts}\n  due: {type: date}\n');
  put('modules/local/collections/users.collection.yaml', 'name: users\noverlay: true\nfields:\n  tasks: {type: tasks, many: true, mirror_of: assignee}\n');
  return root;
}

test('discovers npm and workspace modules and resolves mixins, overlays and optional peers', () => {
  const m = buildModel(workspace());
  assert.deepEqual(m.modules.map((x) => `${x.name}:${x.origin}`), ['people:npm', 'local:workspace']);
  assert.deepEqual(m.modules[0].unsupported, ['extension']);
  assert.deepEqual(Object.keys(m.collections.users.fields).sort(), ['kind', 'name', 'notes', 'tasks']);
  assert.equal(m.collections.tasks.fields.ghost, undefined);
  assert.deepEqual(m.collections.tasks.fields.about.type, ['users']);
  assert.equal(m.issues.filter((i) => i.severity === 'warning').length, 2);
});

test('add, get, set, rm round-trip with ids, defaults and body', () => {
  const m = buildModel(workspace());
  const u = add(m, 'users', { name: 'Dana Oren', notes: 'hello\n' });
  assert.equal(u.ref, 'users/dana-oren');
  assert.equal(u.data.kind, 'person');
  assert.match(readFileSync(u.path, 'utf8'), /---\nhello\n$/);
  const t = add(m, 'tasks', { name: 'Call the bank', assignee: 'users/dana-oren', due: '2026-12-01' });
  assert.match(t.id, /^\d{4}-\d{2}-\d{2}--call-the-bank$/);
  assert.equal(set(m, t.ref, { due: '2026-12-02' }).data.due, '2026-12-02');
  assert.deepEqual(listIds(m, 'tasks'), [t.id]);
  assert.equal(check(m).issues.filter((i) => i.severity === 'error').length, 0);
  rm(m, t.ref);
  assert.deepEqual(listIds(m, 'tasks'), []);
});

test('invalid writes are rejected before disk', () => {
  const m = buildModel(workspace());
  const bad: Record<string, unknown>[] = [{}, { name: 'x', nope: 1 }, { name: 'x', due: 'tomorrow' }, { name: 'x', assignee: 'users/nobody' }, { name: 'x', assignee: 'dana' }];
  for (const input of bad) assert.throws(() => add(m, 'tasks', input, 'fixed-id'), DtError);
  assert.throws(() => add(m, 'users', { name: 'Bot', kind: 'robot' }), DtError);
  assert.equal(existsSync(join(m.root, 'data')), false);
});

test('a stale write and a failed set leave the file intact', () => {
  const m = buildModel(workspace());
  const u = add(m, 'users', { name: 'Dana' });
  const before = readFileSync(u.path, 'utf8');
  assert.throws(() => set(m, u.ref, { kind: 'robot' }), DtError);
  assert.equal(readFileSync(u.path, 'utf8'), before);
  assert.throws(() => add(m, 'users', { name: 'Dana' }), /already exists/);
});

test('compile writes only under .dt and is reproducible', () => {
  const m = buildModel(workspace());
  const files = compile(m);
  assert.ok(files.every((f) => f.startsWith(join(m.root, '.dt'))));
  const first = readFileSync(join(m.root, '.dt/model.json'), 'utf8');
  compile(buildModel(m.root));
  assert.equal(readFileSync(join(m.root, '.dt/model.json'), 'utf8'), first);
  assert.match(readFileSync(join(m.root, '.dt/AGENTS.md'), 'utf8'), /\*\*tasks\*\* \(local\)/);
});
