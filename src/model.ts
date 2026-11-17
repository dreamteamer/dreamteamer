// Model: aggregate every module's collections, mixins and overlays into one resolved workspace model.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { parse } from 'yaml';
import { discover } from './discover.ts';
import type { Collection, Field, Issue, Model, Module, Skill } from './types.ts';

export const SCALARS = new Set(['string', 'markdown', 'date', 'datetime', 'integer', 'number', 'boolean', 'url', 'email', 'object', 'map', 'position', 'reference']);
const FORMATS = new Set(['md', 'yaml', 'json', 'binary']);
const DESCRIPTOR_KEYS = new Set(['name', 'title', 'singular', 'description', 'use_when', 'storage', 'ids', 'fields', 'mixins', 'overlay', 'display', 'record_title', 'internal', 'constraints', 'sensitive']);

function walk(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, suffix)); else if (name.endsWith(suffix)) out.push(p);
  }
  return out;
}

interface Source { module: Module; file: string; doc: any }

function sources(modules: Module[], kind: string, suffix: string, issues: Issue[]): Source[] {
  const out: Source[] = [];
  for (const module of modules) for (const file of walk(join(module.dir, kind), suffix)) {
    try { out.push({ module, file, doc: parse(readFileSync(file, 'utf8')) ?? {} }); }
    catch (e) { issues.push({ severity: 'error', where: file, message: `unreadable YAML: ${(e as Error).message}` }); }
  }
  return out;
}

const INVARIANT = new Set(['series', 'species', 'news']);
function singularWord(w: string): string {
  if (INVARIANT.has(w)) return w;
  if (w.endsWith('yses')) return w.slice(0, -4) + 'ysis';
  if (/[^aeiou]ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(sses|shes|ches|xes|zes|uses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('ss')) return w;
  return w.endsWith('s') ? w.slice(0, -1) : w;
}
/** a collection's name in the singular: the last word of its last segment is inflected (`rnd/user-stories` → `rnd/user-story`) */
export function singular(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('-')) + 1;
  return name.slice(0, cut) + singularWord(name.slice(cut));
}
const bare = (name: string) => name.slice(name.lastIndexOf('/') + 1);

export function buildModel(root: string): Model {
  const { modules, issues } = discover(root);
  const peers = [...new Set(modules.flatMap((m) => m.peers))];
  const mixins = new Map<string, any>();
  for (const s of sources(modules, 'mixins', '.mixin.yaml', issues)) mixins.set(s.doc.name, s.doc);

  const all = sources(modules, 'collections', '.collection.yaml', issues);
  const collections: Record<string, Collection> = {};
  for (const { module, file, doc } of all.filter((s) => !s.doc.overlay)) {
    if (!doc.name) { issues.push({ severity: 'error', where: file, message: 'collection has no name' }); continue; }
    if (collections[doc.name]) { issues.push({ severity: 'error', where: file, message: `collection ${doc.name} is already declared by ${collections[doc.name].module}` }); continue; }
    const unknown = Object.keys(doc).filter((k) => !DESCRIPTOR_KEYS.has(k));
    if (unknown.length) issues.push({ severity: 'warning', where: doc.name, message: `unknown descriptor key(s) ${unknown.join(', ')} — ignored` });
    let merged: any = { fields: {} };
    for (const mx of doc.mixins ?? []) {
      const m = mixins.get(mx);
      if (!m) { issues.push({ severity: 'error', where: doc.name, message: `unknown mixin ${mx}` }); continue; }
      merged = { ...merged, ...m, fields: { ...merged.fields, ...m.fields } };
    }
    merged = { ...merged, ...doc, fields: { ...merged.fields, ...doc.fields } };
    const from = merged.ids?.from ?? '{{ name | slug }}';
    const storage = { path: `data/${doc.name}`, format: 'md', suffix: bare(singular(doc.name)), ...merged.storage };
    if (isAbsolute(storage.path) || normalize(storage.path).startsWith('..')) issues.push({ severity: 'warning', where: doc.name, message: `its storage path, ${storage.path}, is outside the workspace — this engine neither reads nor writes its records` });
    if (!FORMATS.has(storage.format)) issues.push({ severity: 'error', where: doc.name, message: `unknown storage format "${storage.format}" — md, yaml, json or binary` });
    collections[doc.name] = {
      name: doc.name, singular: doc.singular ? doc.name.slice(0, doc.name.lastIndexOf('/') + 1) + doc.singular : singular(doc.name),
      module: module.name, description: doc.description, use_when: doc.use_when, storage,
      ids: { from: Array.isArray(from) ? from : [from], pattern: merged.ids?.pattern },
      fields: merged.fields as Record<string, Field>, contributors: [],
    };
  }
  for (const { module, doc } of all.filter((s) => s.doc.overlay)) {
    const base = collections[doc.name];
    if (!base) continue; // an overlay of an absent optional peer is silent by contract
    for (const [name, field] of Object.entries<Field>(doc.fields ?? {})) {
      if (base.fields[name]) issues.push({ severity: 'warning', where: `${doc.name}.${name}`, message: `overlay from ${module.name} redefines an existing field` });
      base.fields[name] = { ...base.fields[name], ...field };
    }
    if (!base.contributors.includes(module.name)) base.contributors.push(module.name);
  }
  // a field's type is a scalar, an installed collection, or a collection some module declares as an optional
  // peer. A peer that is absent keeps its field: a value there is unresolvable, not wrong. Anything else is a typo.
  for (const c of Object.values(collections)) for (const [name, f] of Object.entries(c.fields)) {
    if (!f?.type) { issues.push({ severity: 'error', where: `${c.name}.${name}`, message: 'field has no type' }); delete c.fields[name]; continue; }
    if (typeof f.type === 'string' && SCALARS.has(f.type)) continue;
    const bad = [f.type].flat().filter((t) => !collections[t] && !peers.includes(t));
    if (!bad.length) continue;
    issues.push({ severity: 'error', where: `${c.name}.${name}`, message: `unknown type "${bad.join(', ')}" — a type is one of ${[...SCALARS].join(' ')}, an installed collection, or a collection a module lists under peer_collections` });
    delete c.fields[name];
  }
  const skills: Skill[] = [];
  for (const module of modules) for (const file of walk(join(module.dir, 'skills'), 'SKILL.md')) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'));
    let doc: any = {};
    try { doc = fm ? parse(fm[1]) ?? {} : {}; } catch { /* a skill with unreadable frontmatter is listed by its path */ }
    skills.push({ name: doc.name ?? relative(join(module.dir, 'skills'), file), module: module.name, description: doc.description ?? '', path: file });
  }
  let exports: Record<string, string[]> = {};
  const exportsFile = join(root, 'dreamteamer-exports.json');
  if (existsSync(exportsFile)) {
    try {
      const refs = JSON.parse(readFileSync(exportsFile, 'utf8')).references ?? {};
      exports = Object.fromEntries(Object.entries<any>(refs).map(([c, ids]) => [c, Object.keys(ids)]));
    } catch (e) { issues.push({ severity: 'error', where: exportsFile, message: `unreadable: ${(e as Error).message}` }); }
  }
  return { root, modules, collections, skills, peers, exports, issues };
}

/** the collection a command names: its name, or its singular */
export function findCollection(model: Model, name: string): Collection | undefined {
  return model.collections[name] ?? Object.values(model.collections).find((c) => c.singular === name);
}

/**
 * Split `<collection>/<id>` at the longest declared collection name (namespaces contain slashes).
 * Strict by default — a reference stored in a record names its collection in full. With `aliases`, the
 * singular is accepted too, which is what a command line may type.
 */
export function splitRef(model: Model, ref: string, aliases = false): { collection: string; id: string } | null {
  if (typeof ref !== 'string') return null;
  // a full name wins over another collection's singular of the same spelling
  const all = Object.values(model.collections);
  const names: [string, string][] = [...all.map((c): [string, string] => [c.name, c.name]), ...(aliases ? all.map((c): [string, string] => [c.singular, c.name]) : [])];
  const hit = names.map((t, n) => ({ t, n })).sort((a, b) => b.t[0].length - a.t[0].length || a.n - b.n).map((x) => x.t).find(([n]) => ref.startsWith(n + '/'));
  return hit ? { collection: hit[1], id: ref.slice(hit[0].length + 1) } : null;
}
