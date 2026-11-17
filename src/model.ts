// Model: aggregate every module's collections, mixins and overlays into one resolved workspace model.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { discover } from './discover.ts';
import type { Collection, Field, Issue, Model, Module, Skill } from './types.ts';

export const SCALARS = new Set(['string', 'markdown', 'date', 'datetime', 'integer', 'number', 'boolean', 'url', 'email', 'object', 'map', 'reference']);

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

export function singular(name: string): string {
  const last = name.split('/').pop()!;
  return last.endsWith('s') ? last.slice(0, -1) : last;
}

export function buildModel(root: string): Model {
  const { modules, issues } = discover(root);
  const mixins = new Map<string, any>();
  for (const s of sources(modules, 'mixins', '.mixin.yaml', issues)) mixins.set(s.doc.name, s.doc);

  const all = sources(modules, 'collections', '.collection.yaml', issues);
  const collections: Record<string, Collection> = {};
  for (const { module, file, doc } of all.filter((s) => !s.doc.overlay)) {
    if (!doc.name) { issues.push({ severity: 'error', where: file, message: 'collection has no name' }); continue; }
    if (collections[doc.name]) { issues.push({ severity: 'error', where: file, message: `collection ${doc.name} is already declared by ${collections[doc.name].module}` }); continue; }
    let merged: any = { fields: {} };
    for (const mx of doc.mixins ?? []) {
      const m = mixins.get(mx);
      if (!m) { issues.push({ severity: 'error', where: doc.name, message: `unknown mixin ${mx}` }); continue; }
      merged = { ...merged, ...m, fields: { ...merged.fields, ...m.fields } };
    }
    merged = { ...merged, ...doc, fields: { ...merged.fields, ...doc.fields } };
    const from = merged.ids?.from ?? '{{ name | slug }}';
    collections[doc.name] = {
      name: doc.name, module: module.name, description: doc.description, use_when: doc.use_when,
      storage: { path: `data/${doc.name}`, format: 'md', ...merged.storage },
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
  // a field whose type names an absent collection belongs to an optional peer: drop it, say so
  for (const c of Object.values(collections)) for (const [name, f] of Object.entries(c.fields)) {
    if (!f?.type) { issues.push({ severity: 'error', where: `${c.name}.${name}`, message: 'field has no type' }); continue; }
    if (typeof f.type === 'string' && SCALARS.has(f.type)) continue;
    const targets = [f.type].flat(), present = targets.filter((t) => collections[t]);
    if (present.length === targets.length) continue;
    const absent = targets.filter((t) => !collections[t]).join(', ');
    if (present.length) { f.type = present; issues.push({ severity: 'warning', where: `${c.name}.${name}`, message: `may point at ${absent}, not installed — narrowed` }); }
    else { delete c.fields[name]; issues.push({ severity: 'warning', where: `${c.name}.${name}`, message: `points at ${absent}, not installed — field dropped` }); }
  }
  const skills: Skill[] = [];
  for (const module of modules) for (const file of walk(join(module.dir, 'skills'), 'SKILL.md')) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'));
    const doc = fm ? parse(fm[1]) : {};
    skills.push({ name: doc.name ?? relative(join(module.dir, 'skills'), file), module: module.name, description: doc.description ?? '', path: file });
  }
  let exports: Record<string, string[]> = {};
  const exportsFile = join(root, 'dreamteamer-exports.json');
  if (existsSync(exportsFile)) {
    const refs = JSON.parse(readFileSync(exportsFile, 'utf8')).references ?? {};
    exports = Object.fromEntries(Object.entries<any>(refs).map(([c, ids]) => [c, Object.keys(ids)]));
  }
  return { root, modules, collections, skills, exports, issues };
}

/** split `<collection>/<id>` at the longest declared collection name (namespaces contain slashes) */
export function splitRef(model: Model, ref: string): { collection: string; id: string } | null {
  const names = Object.keys(model.collections).sort((a, b) => b.length - a.length);
  const hit = names.find((n) => ref.startsWith(n + '/'));
  return hit ? { collection: hit, id: ref.slice(hit.length + 1) } : null;
}
