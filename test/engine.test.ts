import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DtError, add, buildModel, check, compile, findCollection, get, list, listIds, referrers, rm, set } from '../src/api.ts';
import { put, workspace } from './helpers.ts';

const errors = (m: ReturnType<typeof buildModel>) => check(m).issues.filter((i) => i.severity === 'error');
const refuses = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof DtError && re.test([e.message, ...e.issues.map((i) => i.message)].join('\n')));

test('finds npm and workspace modules and resolves mixins, overlays and declared peers', () => {
  const m = buildModel(workspace());
  assert.deepEqual(m.modules.map((x) => `${x.name}:${x.origin}`), ['people:npm', 'local:workspace']);
  assert.deepEqual(m.modules[0].unsupported, ['extension']);
  assert.deepEqual(Object.keys(m.collections.users.fields).sort(), ['joined', 'kind', 'name', 'notes', 'site', 'tasks']);
  assert.deepEqual(m.collections.tasks.fields.about.type, ['users', 'ghosts'], 'a declared peer keeps its place in a union');
  assert.equal(m.collections.tasks.fields.ghost.type, 'ghosts', 'and keeps its field');
  assert.deepEqual(m.issues, []);
});

test('a typo in a descriptor is an error that stops writes and compile', () => {
  const root = workspace();
  put(root, 'modules/local/collections/gadgets.collection.yaml', 'name: gadgets\ncolour: red\nstorage: {format: toml}\nfields:\n  name: {type: string}\n  size: {type: strng}\n  rank: {type: position}\n  loose: {}\n');
  const m = buildModel(root);
  const text = m.issues.map((i) => `${i.severity} ${i.where}: ${i.message}`).join('\n');
  assert.match(text, /error gadgets\.size: unknown type "strng"/);
  assert.match(text, /error gadgets: unknown storage format "toml"/);
  assert.match(text, /error gadgets\.loose: field has no type/);
  assert.match(text, /warning gadgets: unknown descriptor key\(s\) colour/);
  assert.equal(m.collections.gadgets.fields.rank.type, 'position', 'position is a known type');
  refuses(() => add(m, 'users', { name: 'Dana Oren' }), /model has errors/);
  refuses(() => compile(m), /model has errors/);
  assert.equal(existsSync(join(root, 'data')), false);
});

test('a module error does not crash discovery, and a folder with no module is not a workspace', () => {
  const root = workspace();
  put(root, 'modules/broken/package.json', '{ broken');
  assert.match(buildModel(root).issues[0].message, /unreadable package\.json/);
  refuses(() => buildModel(dirname(root) + '/nowhere-' + Date.now()), /not a workspace/);
  const plain = workspace();
  writeFileSync(join(plain, 'package.json'), '{"name":"lib"}');
  cpSync(join(plain, 'modules'), join(plain, 'kept'), { recursive: true });
  for (const d of readdirSync(join(plain, 'modules'))) writeFileSync(join(plain, 'modules', d, 'package.json'), '{}');
  refuses(() => buildModel(plain), /no dreamteamer module/);
});

test('plural names inflect as the released engine does, for the file suffix and for the command line', () => {
  const root = workspace(), m = buildModel(root);
  assert.equal(m.collections.companies.storage.suffix, 'company');
  assert.equal(m.collections.stories.storage.suffix, 'story');
  assert.equal(findCollection(m, 'company')?.name, 'companies');
  put(root, 'data/companies/northwind.company.md', '---\nname: Northwind\n---\n');
  assert.deepEqual(listIds(m, 'companies'), ['northwind']);
  assert.equal(get(m, 'company/northwind').ref, 'companies/northwind', 'a command may name the collection in the singular');
  assert.match(add(m, 'stories', { name: 'Sign in' }).path, /sign-in\.story\.md$/);
});

test('add writes the file the released engine writes: given fields, created, then defaults', () => {
  const m = buildModel(workspace());
  const u = add(m, 'users', { name: 'Dana Oren', notes: 'Met at the fair.' });
  assert.equal(u.ref, 'users/dana-oren');
  const text = readFileSync(u.path, 'utf8');
  assert.match(text, /^---\nname: Dana Oren\ncreated: '\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d'\nkind: person\n---\nMet at the fair\.\n$/);
  const t = add(m, 'tasks', { name: 'Call the bank', assignee: 'users/dana-oren', due: '2026-12-01', tags: 'finance' });
  assert.match(t.id, /^\d{4}-\d{2}-\d{2}--call-the-bank$/);
  assert.equal(t.id.slice(0, 10), String(t.data.created).slice(0, 10), 'the id takes the local day');
  assert.deepEqual(t.data.tags, ['finance'], 'one value for a list field is a list of one');
  assert.match(readFileSync(t.path, 'utf8'), /due: '2026-12-01'\ntags:\n  - finance\n/);
  assert.equal(set(m, t.ref, { due: '2026-12-02' }).data.due, '2026-12-02');
  assert.deepEqual(list(m, 'tasks', { assignee: 'users/dana-oren' }).map((r) => r.id), [t.id]);
  assert.deepEqual(list(m, 'tasks', { status: 'done' }), []);
  assert.deepEqual(errors(m), []);
  rm(m, t.ref);
  assert.deepEqual(listIds(m, 'tasks'), []);
});

test('ids: date formats, basename, accents, and a hash that says it is one', () => {
  const m = buildModel(workspace());
  add(m, 'companies', { name: 'Northwind' });
  const starts = '2026-11-20T10:30:00+02:00';
  assert.equal(add(m, 'meetings', { name: 'Weekly sync', starts, company: 'companies/northwind' }).id, '2026/11/2026-11-20--10-30--northwind--weekly-sync');
  assert.equal(add(m, 'meetings', { name: 'Stand-up', starts }).id, '2026/11/2026-11-20--10-30--stand-up', 'the next template when a field is absent');
  assert.deepEqual(listIds(m, 'meetings').length, 2, 'nested ids are listed');
  assert.equal(add(m, 'users', { name: 'Zoë Brontë-Ångström' }).id, 'zoe-bronte-angstrom');
  const greek = add(m, 'companies', { name: 'Ελένη Παπαδοπούλου' });
  assert.equal(greek.id, 'x0n36jsv', 'the released engine\'s hash for the same name');
  assert.match(greek.warnings![0], /the id is a hash/);
  refuses(() => add(m, 'tasks', { due: '2026-12-01' }), /cannot make an id — give name/);
});

test('invalid writes are rejected before disk', () => {
  const m = buildModel(workspace());
  const bad: [Record<string, unknown>, RegExp][] = [
    [{}, /name: required/], [{ name: 'x', nope: 1 }, /nope: unknown field/], [{ name: 'x', due: 'tomorrow' }, /real date/],
    [{ name: 'x', due: '2026-13-45' }, /real date/], [{ name: 'x', at: 'March 5' }, /date and time with a zone/],
    [{ name: 'x', assignee: 'users/nobody' }, /broken reference/], [{ name: 'x', assignee: 'dana' }, /users\/<id> reference/],
    [{ name: 'x', estimate: 0 }, /minimum 1/], [{ name: 'x', estimate: 1.5 }, /integer/], [{ name: 'x', urgent: 'maybe' }, /true or false/],
    [{ name: 'x', status: 'later' }, /not one of todo \| done/], [{ name: 'x', created: 'last week' }, /created/], [{ name: 'x', updated: '2026-11-01' }, /updated: unknown field/],
  ];
  for (const [input, why] of bad) refuses(() => add(m, 'tasks', input, '2026-01-01--fixed'), why);
  refuses(() => add(m, 'users', { name: 'Bot', kind: 'robot' }), /not one of/);
  refuses(() => add(m, 'users', { name: 'Web', site: 'not a url' }), /URL/);
  assert.equal(existsSync(join(m.root, 'data')), false);
});

test('check is as lenient as the released engine about how a value is written', () => {
  const root = workspace(), m = buildModel(root);
  add(m, 'users', { name: 'Dana Oren' });
  put(root, 'data/tasks/2026-01-01--hand.task.md', "---\nname: 2026\nestimate: '3'\nurgent: 'true'\nassignee: [users/dana-oren]\n---\n");
  assert.deepEqual(errors(m), []);
});

test('a reference into a declared peer that is not installed is unresolved, not wrong', () => {
  const root = workspace(), m = buildModel(root);
  put(root, 'data/tasks/2026-01-01--haunted.task.md', '---\nname: Haunted\nghost: ghosts/casper\nabout: ghosts/casper\n---\n');
  const { issues } = check(m);
  assert.deepEqual(issues.map((i) => `${i.severity} ${i.where}`), ['warning ghosts']);
  assert.match(issues[0].message, /2 reference\(s\)/);
  assert.equal(set(m, 'tasks/2026-01-01--haunted', { status: 'done' }).data.status, 'done', 'and the record stays editable');
  refuses(() => set(m, 'tasks/2026-01-01--haunted', { ghost: 'users/casper' }), /ghosts\/<id> reference/);
});

test('a reference or an id cannot reach outside the record it names', () => {
  const root = workspace(), m = buildModel(root);
  add(m, 'users', { name: 'Dana Oren' });
  const victim = put(dirname(root), `victim-${Date.now()}/secret.user.md`, '---\nname: Victim\n---\n');
  const out = `../../../${dirname(victim).split('/').pop()}/secret`;
  for (const id of [out, '..', '.', '', 'a//b', '/abs', 'a/../b', '../tasks/x']) {
    refuses(() => get(m, `users/${id}`), /invalid id/);
    refuses(() => set(m, `users/${id}`, { kind: 'agent' }), /invalid id/);
    refuses(() => rm(m, `users/${id}`), /invalid id/);
    refuses(() => rm(m, `pages/${id}`), /invalid id/);
    refuses(() => add(m, 'memos', { title: 'Planted' }, id), /invalid id/);
  }
  refuses(() => get(m, undefined as unknown as string), /which record/);
  assert.equal(readFileSync(victim, 'utf8'), '---\nname: Victim\n---\n');
  assert.deepEqual(readdirSync(join(root, 'data')), ['users']);
});

test('rm refuses to break other records, or to take them along', () => {
  const root = workspace(), m = buildModel(root);
  add(m, 'users', { name: 'Dana Oren' });
  const t = add(m, 'tasks', { name: 'Call the bank', assignee: 'users/dana-oren' });
  assert.deepEqual(referrers(m, 'users/dana-oren'), [t.ref]);
  refuses(() => rm(m, 'users/dana-oren'), /referenced by 1 record/);
  assert.ok(existsSync(join(root, 'data/users/dana-oren.user.md')));
  add(m, 'pages', { name: 'Welcome', content: 'Hello.' });
  put(root, 'data/pages/welcome/cover.txt', 'cover');
  put(root, 'data/pages/welcome/notes/kept.memo.md', '---\ntitle: Kept\n---\n');
  refuses(() => rm(m, 'pages/welcome'), /holds 1 record\(s\) of other collections/);
  assert.equal(rm(m, 'pages/welcome', true), 'pages/welcome');
  assert.equal(existsSync(join(root, 'data/pages/welcome')), false);
  assert.equal(rm(m, 'users/dana-oren', true), 'users/dana-oren');
  assert.match(errors(m)[0].message, /broken reference users\/dana-oren/);
});

test('set changes the lines it was asked to change and keeps the rest of the file', () => {
  const root = workspace(), m = buildModel(root);
  const path = put(root, 'data/users/sam-diaz.user.md', "---\n# joined through the Northwind referral\nname: \"Sam Diaz\"   # as on the badge\nkind: agent\njoined: '2026-11-01'\n---\n\nPrefers mornings.\n");
  const before = readFileSync(path, 'utf8');
  set(m, 'users/sam-diaz', { site: 'https://northwind.example' });
  assert.equal(readFileSync(path, 'utf8'), before.replace("joined: '2026-11-01'\n", "joined: '2026-11-01'\nsite: https://northwind.example\n"));
  set(m, 'users/sam-diaz', { site: null, kind: '' });
  assert.equal(readFileSync(path, 'utf8'), before.replace('kind: agent', 'kind: person'), 'a cleared field with a default goes back to it');
  set(m, 'users/sam-diaz', { notes: 'Prefers evenings.' });
  assert.match(readFileSync(path, 'utf8'), /---\nPrefers evenings\.\n$/);
  refuses(() => set(m, 'users/sam-diaz', { kind: 'robot' }), /not one of/);
  assert.match(readFileSync(path, 'utf8'), /# joined through the Northwind referral\nname: "Sam Diaz"   # as on the badge\n/);
});

test('a failed or repeated write leaves what is on disk, and old temporary files are cleared', () => {
  const root = workspace(), m = buildModel(root);
  const u = add(m, 'users', { name: 'Dana' });
  const before = readFileSync(u.path, 'utf8');
  refuses(() => set(m, u.ref, { kind: 'robot' }), /not one of/);
  refuses(() => add(m, 'users', { name: 'Dana' }), /already exists/);
  assert.equal(readFileSync(u.path, 'utf8'), before);
  const stale = `${u.path}.99999.tmp`, old = new Date(Date.now() - 3_600_000);
  writeFileSync(stale, 'half');
  utimesSync(stale, old, old);
  assert.match(check(m).issues[0].message, /unrecognized file/);
  set(m, u.ref, { kind: 'agent' });
  assert.deepEqual(readdirSync(dirname(u.path)), ['dana.user.md']);
});

test('check reports files no collection recognises, and JSON and folder records round-trip', () => {
  const root = workspace(), m = buildModel(root);
  put(root, 'data/users/ana.person.md', '---\nname: Ana\nkind: nonsense\n---\n');
  mkdirSync(join(root, 'data/users/dir.user.md'));
  assert.match(check(m).issues.map((i) => `${i.severity} ${i.where}`).join(), /warning data\/users\/ana\.person\.md/);
  assert.deepEqual(listIds(m, 'users'), []);
  const place = add(m, 'places', { name: 'Harbor Cafe', city: 'Lisbon' });
  assert.equal(JSON.parse(readFileSync(place.path, 'utf8')).city, 'Lisbon');
  assert.equal(set(m, place.ref, { city: 'Porto' }).data.city, 'Porto');
  const page = add(m, 'pages', { name: 'Welcome', content: 'Hello.' });
  assert.match(page.path, /data\/pages\/welcome\/index\.md$/);
  assert.deepEqual(listIds(m, 'pages'), ['welcome']);
});

test('compile writes only under .dt, is the same wherever the workspace sits, and says enough to write a record', () => {
  const root = workspace(), m = buildModel(root);
  const files = compile(m);
  assert.ok(files.every((f) => f.startsWith(join(root, '.dt'))));
  const model = readFileSync(join(root, '.dt/model.json'), 'utf8'), agents = readFileSync(join(root, '.dt/AGENTS.md'), 'utf8');
  assert.equal(model.includes(root), false, 'no absolute path of the workspace');
  const moved = root + '-moved';
  cpSync(root, moved, { recursive: true });
  compile(buildModel(moved));
  assert.equal(readFileSync(join(moved, '.dt/model.json'), 'utf8'), model);
  assert.match(agents, /node .*bin\/dt\.ts <verb>/);
  assert.match(agents, /\*\*tasks\*\* \(local\)[\s\S]*records: data\/tasks\/<id>\.task\.md · id from `\{\{ created \| date \}\}--\{\{ name \| slug \}\}`/);
  assert.match(agents, /fields: name\*: string · assignee: → users · about: → users\|ghosts .* tags\[\]: string .* status: todo\|done \(default todo\) · notes: the text below the frontmatter/);
});
