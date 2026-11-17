// Fixtures shared by the suites: an invented workspace, a workspace of real published modules, and the CLI.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE = fileURLToPath(new URL('..', import.meta.url));

export function put(root: string, path: string, text: string): string {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  return join(root, path);
}
const descriptor = (name: string, rest: string) => `name: ${name}\ndescription: ${name}.\n${rest}`;

/** one npm module (`people`) and one local module, covering every shape the engine handles */
export function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dt-fp-'));
  const p = (path: string, text: string) => put(root, path, text);
  p('package.json', JSON.stringify({ name: 'ws', dependencies: { people: '1.0.0' } }));
  p('node_modules/people/package.json', JSON.stringify({ name: 'people', version: '1.0.0', dreamteamer: { extension: './x.mjs', peer_collections: ['ghosts'] } }));
  p('node_modules/people/mixins/entity.mixin.yaml', 'name: entity\nids: {from: "{{ name | slug }}", pattern: "^[a-z0-9-]+$"}\nfields:\n  name: {type: string, required: true}\n  notes: {type: markdown, body: true}\n');
  p('node_modules/people/collections/users.collection.yaml', descriptor('users', 'mixins: [entity]\nstorage: {path: data/users, format: md}\nfields:\n  kind: {type: string, default: person, enum: [person, agent]}\n  site: {type: url}\n  joined: {type: date}\n'));
  p('modules/local/package.json', JSON.stringify({ name: 'local', version: '0.0.1', dreamteamer: {} }));
  const c = (name: string, rest: string) => p(`modules/local/collections/${name}.collection.yaml`, descriptor(name, rest));
  c('tasks', 'ids: {from: "{{ created | date }}--{{ name | slug }}"}\nfields:\n  name: {type: string, required: true}\n  assignee: {type: users}\n  about: {type: [users, ghosts]}\n  ghost: {type: ghosts}\n  due: {type: date}\n  at: {type: datetime}\n  tags: {type: string, many: true}\n  urgent: {type: boolean}\n  estimate: {type: integer, minimum: 1}\n  status: {type: string, default: todo, enum: [todo, done]}\n  notes: {type: markdown, body: true}\n');
  p('modules/local/collections/users-overlay.collection.yaml', 'name: users\noverlay: true\nfields:\n  tasks: {type: tasks, many: true, mirror_of: assignee}\n');
  c('companies', 'fields:\n  name: {type: string, required: true}\n');
  c('stories', 'fields:\n  name: {type: string, required: true}\n  owner: {type: users}\n');
  c('pages', 'storage: {path: data/pages, format: md, shape: folder, entry: index.md}\nfields:\n  name: {type: string, required: true}\n  content: {type: markdown, body: true}\n');
  c('memos', 'fields:\n  title: {type: string, required: true}\n');
  c('places', 'storage: {format: json}\nfields:\n  name: {type: string, required: true}\n  city: {type: string}\n');
  c('meetings', 'ids:\n  from:\n    - "{{ starts | date:YYYY/MM }}/{{ starts | date }}--{{ starts | date:HH-mm }}--{{ company | basename }}--{{ name | slug }}"\n    - "{{ starts | date:YYYY/MM }}/{{ starts | date }}--{{ starts | date:HH-mm }}--{{ name | slug }}"\nfields:\n  name: {type: string, required: true}\n  starts: {type: datetime}\n  company: {type: companies}\n');
  return root;
}

/** a workspace of the published modules this repository installs for its tests, at their pinned versions */
export function publishedWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dt-fp-real-'));
  // `dreamteamer` is the released engine's own package: it is also the system module that defines `repos`
  const names = ['dreamteamer', ...['tasks', 'users', 'companies', 'contacts', 'assets', 'meetings', 'rnd'].map((n) => `@dreamteamer/${n}`)];
  put(root, 'package.json', JSON.stringify({ name: 'published', dependencies: Object.fromEntries(names.map((n) => [n, '*'])) }));
  symlinkSync(join(ENGINE, 'node_modules'), join(root, 'node_modules'));
  return root;
}

export function dt(cwd: string, ...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [join(ENGINE, 'bin/dt.ts'), ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
