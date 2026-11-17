// Store: read and safely change user-owned records under the workspace root. Never writes anywhere else.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { SCALARS, singular, splitRef } from './model.ts';
import { DtError } from './types.ts';
import type { Collection, DtRecord, Field, Issue, Model } from './types.ts';

const IMPLICIT = new Set(['created', 'updated']);

function coll(model: Model, name: string): Collection {
  const c = model.collections[name] ?? model.collections[Object.keys(model.collections).find((n) => singular(n) === name) ?? ''];
  if (!c) throw new DtError(`unknown collection ${name}`);
  if (c.storage.format === 'binary') throw new DtError(`${c.name}: binary storage is not supported by this experiment`);
  return c;
}
const tail = (c: Collection) => c.storage.shape === 'folder' ? `/${c.storage.entry ?? 'index.md'}` : `.${c.storage.suffix ?? singular(c.name)}.${c.storage.format}`;
const fileOf = (model: Model, c: Collection, id: string) => join(model.root, c.storage.path, id + tail(c));
const bodyField = (c: Collection) => Object.keys(c.fields).find((f) => c.fields[f].body);

export function listIds(model: Model, name: string): string[] {
  const c = coll(model, name);
  const base = join(model.root, c.storage.path), t = tail(c), out: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      if (p.endsWith(t)) out.push(relative(base, p).slice(0, -t.length).split(sep).join('/'));
    }
  };
  if (existsSync(base)) walk(base);
  return out.sort();
}

export function get(model: Model, ref: string): DtRecord {
  const at = splitRef(model, ref);
  if (!at) throw new DtError(`${ref}: not a <collection>/<id> reference`);
  const c = coll(model, at.collection), path = fileOf(model, c, at.id);
  if (!existsSync(path)) throw new DtError(`${ref}: no such record`);
  const text = readFileSync(path, 'utf8');
  let data: Record<string, unknown>;
  if (c.storage.format === 'md') {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    data = m ? (parse(m[1]) ?? {}) : {};
    const body = (m ? m[2] : text), bf = bodyField(c);
    if (bf && body.trim()) data[bf] = body;
  } else data = (c.storage.format === 'json' ? JSON.parse(text) : parse(text)) ?? {};
  return { ref: `${c.name}/${at.id}`, collection: c.name, id: at.id, path, data, mtimeMs: statSync(path).mtimeMs };
}

export const refExists = (model: Model, ref: string): boolean => {
  const at = splitRef(model, ref);
  if (!at) return false;
  if (model.exports[at.collection]?.includes(at.id)) return true;
  const c = model.collections[at.collection];
  return c.storage.format !== 'binary' ? existsSync(fileOf(model, c, at.id)) : existsSync(join(model.root, c.storage.path, at.id));
};

function checkValue(model: Model, f: Field, v: unknown): string | null {
  switch (typeof f.type === 'string' ? f.type : 'ref') {
    case 'string': case 'markdown': case 'url': case 'email': if (typeof v !== 'string') return 'expected a string'; break;
    case 'boolean': if (typeof v !== 'boolean') return 'expected true or false'; break;
    case 'integer': if (!Number.isInteger(v)) return 'expected an integer'; break;
    case 'number': if (typeof v !== 'number') return 'expected a number'; break;
    case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return 'expected a date YYYY-MM-DD'; break;
    case 'datetime': if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return 'expected an ISO 8601 timestamp'; break;
    case 'object': case 'map': if (typeof v !== 'object' || v === null) return 'expected a map'; break;
    default: {
      if (typeof v !== 'string') return 'expected a <collection>/<id> reference';
      const targets = [f.type].flat();
      if (f.type !== 'reference' && !targets.some((t) => v.startsWith(t + '/'))) return `expected a ${targets.join(' | ')}/<id> reference`;
      if (!refExists(model, v)) return `broken reference ${v}`;
    }
  }
  if (f.enum && !f.enum.includes(v)) return `not one of ${f.enum.join(' | ')}`;
  if (f.pattern && typeof v === 'string' && !new RegExp(f.pattern).test(v)) return `does not match ${f.pattern}`;
  return null;
}

export function validate(model: Model, collection: string, id: string, data: Record<string, unknown>): Issue[] {
  const c = coll(model, collection), where = `${c.name}/${id}`, issues: Issue[] = [];
  const err = (message: string) => issues.push({ severity: 'error', where, message });
  if (c.ids.pattern && !new RegExp(c.ids.pattern).test(id)) err(`id does not match ${c.ids.pattern}`);
  for (const [name, f] of Object.entries(c.fields)) if (f.required && (data[name] === undefined || data[name] === null || data[name] === '')) err(`${name}: required`);
  for (const [name, v] of Object.entries(data)) {
    const f = c.fields[name];
    if (!f) { if (!IMPLICIT.has(name)) err(`${name}: unknown field`); continue; }
    if (v === null || v === undefined || f.mirror_of) continue;
    const values = f.many ? (Array.isArray(v) ? v : [v]) : [v];
    if (!f.many && Array.isArray(v) && f.type !== 'object' && f.type !== 'map') { err(`${name}: holds a list but the field is not many`); continue; }
    for (const one of values) { const m = checkValue(model, f, one); if (m) err(`${name}: ${m}`); }
  }
  return issues;
}

function write(model: Model, c: Collection, id: string, data: Record<string, unknown>, expectMtime?: number): string {
  const path = fileOf(model, c, id);
  if (!resolve(path).startsWith(resolve(model.root) + sep)) throw new DtError(`${id}: path leaves the workspace`);
  const issues = validate(model, c.name, id, data);
  if (issues.length) throw new DtError(`${c.name}/${id} rejected — nothing written`, issues);
  let text: string;
  if (c.storage.format === 'md') {
    const bf = bodyField(c), { [bf ?? '']: body, ...front } = data;
    text = `---\n${stringify(front, { lineWidth: 120 })}---\n${typeof body === 'string' ? body : ''}`;
  } else text = c.storage.format === 'json' ? JSON.stringify(data, null, 2) + '\n' : stringify(data, { lineWidth: 120 });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  // stale-write guard: the file must be as we read it (or still absent) at the moment we replace it
  const now = existsSync(path) ? statSync(path).mtimeMs : undefined;
  if (now !== expectMtime) { rmSync(tmp); throw new DtError(`${c.name}/${id} changed on disk since it was read — nothing written`); }
  renameSync(tmp, path);
  return path;
}

const FILTERS: Record<string, (v: string) => string> = {
  date: (v) => v.slice(0, 10),
  slug: (v) => {
    const s = v.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || createHash('sha1').update(v).digest('hex').slice(0, 10);
  },
};
function makeId(c: Collection, data: Record<string, unknown>): string {
  for (const tpl of c.ids.from) {
    let ok = true;
    const id = tpl.replace(/\{\{\s*([\w]+)((?:\s*\|\s*\w+)*)\s*\}\}/g, (_m, name: string, filters: string) => {
      if (data[name] === undefined || data[name] === '') { ok = false; return ''; }
      return filters.split('|').map((s) => s.trim()).filter(Boolean).reduce((v, f) => (FILTERS[f] ?? ((x) => x))(v), String(data[name]));
    });
    if (ok) return id;
  }
  throw new DtError(`${c.name}: cannot make an id — pass --id or the fields ${c.ids.from.join(' or ')} needs`);
}

export function add(model: Model, collection: string, input: Record<string, unknown>, id?: string): DtRecord {
  const c = coll(model, collection);
  const data: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(c.fields)) if (f.default !== undefined) data[name] = f.default;
  Object.assign(data, input);
  const stamped = { created: new Date().toISOString(), ...data };
  const newId = id ?? makeId(c, stamped);
  if (existsSync(fileOf(model, c, newId))) throw new DtError(`${c.name}/${newId} already exists`);
  write(model, c, newId, stamped, undefined);
  return get(model, `${c.name}/${newId}`);
}

export function set(model: Model, ref: string, changes: Record<string, unknown>): DtRecord {
  const rec = get(model, ref), data = { ...rec.data };
  for (const [k, v] of Object.entries(changes)) { if (v === null || v === '') delete data[k]; else data[k] = v; }
  write(model, coll(model, rec.collection), rec.id, data, rec.mtimeMs);
  return get(model, rec.ref);
}

export function rm(model: Model, ref: string): string {
  const rec = get(model, ref), c = coll(model, rec.collection);
  rmSync(c.storage.shape === 'folder' ? dirname(rec.path) : rec.path, { recursive: true });
  return rec.ref;
}

/** validate every record of every collection; never modifies anything */
export function check(model: Model): { records: number; issues: Issue[] } {
  const issues: Issue[] = [...model.issues];
  let records = 0;
  for (const c of Object.values(model.collections)) {
    if (c.storage.format === 'binary') continue;
    for (const id of listIds(model, c.name)) {
      records++;
      try { issues.push(...validate(model, c.name, id, get(model, `${c.name}/${id}`).data)); }
      catch (e) { issues.push({ severity: 'error', where: `${c.name}/${id}`, message: (e as Error).message }); }
    }
  }
  return { records, issues };
}
