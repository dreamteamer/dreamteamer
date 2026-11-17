// Store: read and safely change user-owned records under the workspace root. Never writes anywhere else.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Document, isMap, isScalar, parseDocument, visit } from 'yaml';
import { SCALARS, findCollection, splitRef } from './model.ts';
import { DtError } from './types.ts';
import type { Collection, DtRecord, Field, Issue, Model } from './types.ts';

const TEXT = new Set(['string', 'markdown', 'url', 'email', 'position']);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[Tt\s]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?([Zz]|[+-]\d{2}(:?\d{2})?)$/;
const DATEISH = /^\d{4}-\d{2}-\d{2}([Tt\s]|$)/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const SOURCE_FOLDERS = new Set(['modules', 'collections', 'mixins', 'skills', 'agents', 'commands', 'command-bindings', 'ui-views']);

function coll(model: Model, name: string): Collection {
  const c = name ? findCollection(model, name) : undefined;
  if (!c) throw new DtError(name ? `unknown collection ${name} — the collections are ${Object.keys(model.collections).sort().join(', ')}` : 'which collection? name one');
  if (c.storage.format === 'binary') throw new DtError(`${c.name}: binary storage is not supported by this experiment`);
  return c;
}
const entryOf = (c: Collection) => c.storage.entry ?? 'index.md';
const tail = (c: Collection) => c.storage.shape === 'folder' ? `/${entryOf(c)}` : `.${c.storage.suffix}.${c.storage.format}`;
const bodyField = (c: Collection) => Object.keys(c.fields).find((f) => c.fields[f].body);
const isRef = (f: Field) => f.type === 'reference' || typeof f.type !== 'string' || !SCALARS.has(f.type);

/** An id is a relative path inside its collection's folder: no empty, `.` or `..` segment, no leading slash, no control character. */
function checkId(id: string): void {
  if (typeof id !== 'string' || !id || /[\\\u0000-\u001f]/.test(id) || id.split('/').some((s) => !s || s === '.' || s === '..'))
    throw new DtError(`invalid id "${id ?? ''}" — an id is a relative path with no empty, "." or ".." segment and no leading slash`);
}

function fileOf(model: Model, c: Collection, id: string): string {
  checkId(id);
  if (isAbsolute(c.storage.path)) throw new DtError(`${c.name}: its storage path is absolute (${c.storage.path}) — this engine reads and writes only inside the workspace`);
  const base = join(model.root, c.storage.path), path = join(base, id + tail(c));
  if (!resolve(path).startsWith(resolve(model.root) + sep)) throw new DtError(`${c.name}/${id}: its path leaves the workspace`);
  // the collection's folder may itself be a link to somewhere else; nothing below it may lead out of it
  let dir = dirname(path);
  while (!existsSync(dir) && dir.length > base.length) dir = dirname(dir);
  if (existsSync(dir) && existsSync(base) && !(realpathSync(dir) + sep).startsWith(realpathSync(base) + sep))
    throw new DtError(`${c.name}/${id}: a symbolic link leads out of the collection's folder`);
  return path;
}

/** the file exists under exactly this spelling — a file system that ignores case must not turn one id into another */
function present(base: string, path: string): boolean {
  if (!existsSync(path) || statSync(path).isDirectory()) return false;
  let dir = base;
  for (const seg of relative(base, path).split(sep)) { if (!readdirSync(dir).includes(seg)) return false; dir = join(dir, seg); }
  return true;
}

function locate(model: Model, ref: string): { c: Collection; id: string; path: string } {
  const at = splitRef(model, ref, true);
  if (!at) throw new DtError(ref ? `${ref}: not a <collection>/<id> reference` : 'which record? give a <collection>/<id> reference');
  const c = coll(model, at.collection), path = fileOf(model, c, at.id);
  if (!present(join(model.root, c.storage.path), path)) throw new DtError(`${c.name}/${at.id}: no such record`);
  return { c, id: at.id, path };
}

/** regular files below a folder; dotfiles, dot-directories and symbolic links are not records */
function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

export function listIds(model: Model, name: string): string[] {
  const c = coll(model, name);
  const base = join(model.root, c.storage.path), t = tail(c);
  if (!existsSync(base)) return [];
  return walkFiles(base).filter((p) => p.endsWith(t))
    .map((p) => relative(base, p).slice(0, -t.length).split(sep).join('/')).filter((id) => id && !id.endsWith('/')).sort();
}

interface Loaded { rec: DtRecord; c: Collection; doc: Document | null; front: string; body: string }

function load(model: Model, ref: string): Loaded {
  const { c, id, path } = locate(model, ref);
  const mtimeMs = statSync(path).mtimeMs;
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  let doc: Document | null = null, body = '', front = '', data: Record<string, unknown>;
  const fail = (m: string) => new DtError(`${c.name}/${id}: unreadable — ${m.split('\n')[0]}`);
  if (c.storage.format === 'json') {
    try { data = JSON.parse(text) ?? {}; } catch (e) { throw fail((e as Error).message); }
  } else {
    const m = c.storage.format === 'md' ? /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?([\s\S]*)$/.exec(text) : null;
    body = c.storage.format === 'md' ? (m ? m[2] : text) : '';
    front = c.storage.format === 'md' ? (m && m[1] ? m[1] + '\n' : '') : text;
    doc = parseDocument(front);
    if (doc.errors.length) throw fail(doc.errors[0].message);
    let js: unknown;
    try { js = doc.toJS(); } catch (e) { throw fail((e as Error).message); }
    if (js !== null && js !== undefined && (typeof js !== 'object' || Array.isArray(js))) throw fail('its fields are not a map of names to values');
    data = (js ?? {}) as Record<string, unknown>;
    const bf = bodyField(c);
    if (bf && body.trim()) data[bf] = body;
  }
  return { rec: { ref: `${c.name}/${id}`, collection: c.name, id, path, data, mtimeMs }, c, doc, front, body };
}

export const get = (model: Model, ref: string): DtRecord => load(model, ref).rec;

/** the records of a collection, optionally only those whose fields equal the given values */
export function list(model: Model, name: string, where: Record<string, string> = {}): DtRecord[] {
  const c = coll(model, name);
  for (const k of Object.keys(where)) if (!c.fields[k] && k !== 'created') throw new DtError(`${c.name} has no field ${k} to filter on — its fields are ${Object.keys(c.fields).join(', ')}`);
  return listIds(model, c.name).map((id) => get(model, `${c.name}/${id}`))
    .filter((r) => Object.entries(where).every(([k, v]) => [r.data[k]].flat().some((x) => x !== undefined && x !== null && String(x) === v)));
}

export const refExists = (model: Model, ref: string): boolean => {
  const at = splitRef(model, ref);
  if (!at) return false;
  if (model.exports[at.collection]?.includes(at.id)) return true;
  const c = model.collections[at.collection];
  try {
    if (c.storage.format !== 'binary') return present(join(model.root, c.storage.path), fileOf(model, c, at.id));
    // a binary record is the file itself, <id>.<suffix>.<extension>
    checkId(at.id);
    const dir = dirname(join(model.root, c.storage.path, at.id));
    return existsSync(dir) && readdirSync(dir).some((n) => n.startsWith(`${basename(at.id)}.${c.storage.suffix}.`));
  } catch { return false; }
};

const realDate = (y: string, m: string, d: string) => { const t = new Date(Date.UTC(+y, +m - 1, +d)); return t.getUTCFullYear() === +y && t.getUTCMonth() === +m - 1 && t.getUTCDate() === +d; };

/** `unresolved` collects references into peer collections that are declared and not installed */
function checkValue(model: Model, f: Field, v: unknown, unresolved?: Map<string, number>): string | null {
  const type = typeof f.type === 'string' ? f.type : 'ref';
  if (TEXT.has(type)) {
    if (typeof v === 'object') return 'expected text';
    const s = String(v);
    if (type === 'url' && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/.test(s)) return 'expected a URL with a scheme, such as https://…';
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'expected an email address';
    if (typeof f.minLength === 'number' && s.length < f.minLength) return `shorter than ${f.minLength} characters`;
    if (typeof f.maxLength === 'number' && s.length > f.maxLength) return `longer than ${f.maxLength} characters`;
  } else if (type === 'boolean') {
    if (typeof v !== 'boolean' && v !== 'true' && v !== 'false') return 'expected true or false';
  } else if (type === 'integer' || type === 'number') {
    const n = typeof v === 'string' && DECIMAL.test(v) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || (type === 'integer' && !Number.isInteger(n))) return type === 'integer' ? 'expected an integer' : 'expected a number';
    if (typeof f.minimum === 'number' && n < f.minimum) return `less than the minimum ${f.minimum}`;
    if (typeof f.maximum === 'number' && n > f.maximum) return `more than the maximum ${f.maximum}`;
  } else if (type === 'date') {
    const m = DATE.exec(String(v));
    if (!m || !realDate(m[1], m[2], m[3])) return 'expected a real date, YYYY-MM-DD';
  } else if (type === 'datetime') {
    const m = DATETIME.exec(String(v));
    if (!m || !realDate(m[1], m[2], m[3])) return 'expected a date and time with a zone, such as 2026-12-01T10:00:00+02:00';
  } else if (type === 'object' || type === 'map') {
    if (typeof v !== 'object' || v === null) return 'expected a map';
  } else {
    if (typeof v !== 'string') return 'expected a <collection>/<id> reference';
    if (f.type === 'reference') { if (!f.soft && !refExists(model, v)) return `broken reference ${v}`; }
    else {
      const target = [f.type].flat().sort((a, b) => b.length - a.length).find((t) => v.startsWith(t + '/'));
      if (!target) return `expected a ${[f.type].flat().join(' | ')}/<id> reference`;
      if (!model.collections[target]) unresolved?.set(target, (unresolved.get(target) ?? 0) + 1);
      else if (!f.soft && !refExists(model, v)) return `broken reference ${v}`;
    }
  }
  if (f.enum && !f.enum.some((e) => e === v || String(e) === String(v))) return `not one of ${f.enum.join(' | ')}`;
  if (f.pattern && typeof v === 'string' && !new RegExp(f.pattern).test(v)) return `does not match ${f.pattern}`;
  return null;
}

export function validate(model: Model, collection: string, id: string, data: Record<string, unknown>, unresolved?: Map<string, number>): Issue[] {
  const c = coll(model, collection), where = `${c.name}/${id}`, issues: Issue[] = [];
  const err = (message: string) => issues.push({ severity: 'error', where, message });
  if (c.ids.pattern && !new RegExp(c.ids.pattern).test(id)) err(`id does not match ${c.ids.pattern}`);
  for (const [name, f] of Object.entries(c.fields)) if (f.required && data[name] === undefined) err(`${name}: required`);
  for (const [name, v] of Object.entries(data)) {
    if (name === 'created' && !c.fields.created) { if (v != null && checkValue(model, { type: 'datetime' }, v)) err('created: expected a date and time with a zone'); continue; }
    const f = c.fields[name];
    if (!f) { err(`${name}: unknown field — the fields are ${Object.keys(c.fields).join(', ')}`); continue; }
    if (v === null || v === undefined || f.mirror_of) continue;
    const nested = f.type === 'object' || f.type === 'map';
    if (!f.many && !nested && Array.isArray(v) && v.length !== 1) { err(`${name}: holds a list but the field is not many`); continue; }
    const values = Array.isArray(v) && !(nested && !f.many) ? v : [v];
    for (const one of values) { const m = checkValue(model, f, one, unresolved); if (m) err(`${name}: ${m}`); }
  }
  return issues;
}

// ---- writing a record's text ---------------------------------------------------------------------------

/** quote what a YAML 1.1 reader would take for a timestamp, as the released engine's files do */
function scalar(doc: Document, v: unknown): unknown {
  const node = doc.createNode(v);
  visit(node, { Scalar(_k, n) { if (typeof n.value === 'string' && DATEISH.test(n.value)) n.type = 'QUOTE_SINGLE'; } });
  return node;
}
function yamlOf(fields: Record<string, unknown>): string {
  const doc = new Document({});
  for (const [k, v] of Object.entries(fields)) doc.set(k, scalar(doc, v));
  const text = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return text === '{}\n' ? '' : text;
}

/**
 * Change some top-level keys of a YAML text and leave every other character as it was written. A key owns the
 * lines from its own to the end of its value; comments and blank lines between keys stay where they are. A changed
 * key's lines are replaced, a removed key's dropped, a new key goes after the last one. Null when the text is not a
 * block map.
 */
function editYaml(source: string, doc: Document, changes: [string, unknown][]): string | null {
  const map = doc.contents;
  if (!isMap(map) || map.flow) return null;
  const parts: { key?: string; text: string }[] = [];
  let at = 0;
  for (const item of map.items) {
    if (!isScalar(item.key) || !item.key.range) return null;
    const value = item.value as { range?: [number, number, number] | null } | null;
    const start = source.lastIndexOf('\n', item.key.range[0] - 1) + 1, stop = value?.range ? value.range[2] : item.key.range[2];
    const end = stop > 0 && source[stop - 1] === '\n' ? stop : (source.indexOf('\n', stop) + 1 || source.length);
    if (start < at) return null;
    if (start > at) parts.push({ text: source.slice(at, start) });
    parts.push({ key: String(item.key.value), text: source.slice(start, end) });
    at = end;
  }
  const rest = source.slice(at);
  for (const [k, v] of changes) {
    const i = parts.findIndex((p) => p.key === k);
    if (v === undefined) { if (i >= 0) parts.splice(i, 1); }
    else if (i >= 0) parts[i].text = yamlOf({ [k]: v });
    else parts.splice(parts.findLastIndex((p) => p.key !== undefined) + 1, 0, { key: k, text: yamlOf({ [k]: v }) });
  }
  return parts.map((p) => p.text.endsWith('\n') ? p.text : p.text + '\n').join('') + rest;
}

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : 1)) : x);
/** does this YAML text hold exactly these fields? Nothing is written that would not read back as what was meant. */
function holds(yaml: string, fields: Record<string, unknown>): boolean {
  const doc = parseDocument(yaml);
  if (doc.errors.length) return false;
  try { return canon(doc.toJS() ?? {}) === canon(fields); } catch { return false; }
}

function compose(c: Collection, yaml: string, data: Record<string, unknown>, body: string): string {
  if (c.storage.format === 'json') return JSON.stringify(data, null, 2) + '\n';
  return c.storage.format === 'md' ? `---\n${yaml}---\n${body}` : yaml;
}

function write(model: Model, c: Collection, id: string, data: Record<string, unknown>, text: string, expectMtime?: number): string {
  const blocking = model.issues.filter((i) => i.severity === 'error');
  if (blocking.length) throw new DtError('the workspace model has errors — nothing written; fix them first (check lists them)', blocking);
  const path = fileOf(model, c, id);
  const issues = validate(model, c.name, id, data);
  if (issues.length) throw new DtError(`${c.name}/${id} rejected — nothing written`, issues);
  mkdirSync(dirname(path), { recursive: true });
  // a writer that was killed leaves its temporary file behind: clear old ones for this record
  for (const n of readdirSync(dirname(path))) if (n.startsWith(basename(path) + '.') && n.endsWith('.tmp')) {
    const p = join(dirname(path), n);
    if (Date.now() - statSync(p).mtimeMs > 60_000) rmSync(p, { force: true });
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    // stale-write guard: the file must be as we read it (or still absent) at the moment we replace it
    const now = existsSync(path) ? statSync(path).mtimeMs : undefined;
    if (now !== expectMtime) throw new DtError(`${c.name}/${id} changed on disk since it was read — nothing written`);
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
  return path;
}

// ---- ids ---------------------------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');
/** local time with its offset, to the second: 2026-12-01T10:00:00+02:00 */
export function stamp(d = new Date()): string {
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${off < 0 ? '-' : '+'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}
const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function hash(s: string): string {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return 'x' + h.toString(36).padStart(7, '0');
}
/** a date or date-time string is read as written, in its own zone, so an id is the same on every machine */
function formatDate(v: string, fmt: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (!m) throw new DtError(`cannot take a date from "${v}"`);
  const t: Record<string, string> = { YYYY: m[1], MM: m[2], DD: m[3], HH: m[4] ?? '00', mm: m[5] ?? '00', ss: m[6] ?? '00' };
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (k) => t[k]);
}

function makeId(c: Collection, data: Record<string, unknown>, warnings: string[]): string {
  for (const tpl of c.ids.from) {
    let ok = true;
    const id = tpl.replace(/\{\{\s*(\w+)((?:\s*\|\s*\w+(?::[^|}\s]+)?)*)\s*\}\}/g, (_m, name: string, filters: string) => {
      const raw = data[name];
      if (raw === undefined || raw === null || raw === '' || Array.isArray(raw)) { ok = false; return ''; }
      return filters.split('|').map((s) => s.trim()).filter(Boolean).reduce((v, f) => {
        const cut = f.indexOf(':'), fn = cut < 0 ? f : f.slice(0, cut), arg = cut < 0 ? '' : f.slice(cut + 1);
        if (fn === 'date') return formatDate(v, arg || 'YYYY-MM-DD');
        if (fn === 'basename') return v.split('/').pop()!;
        if (fn === 'pad') return v.padStart(Number(arg) || 0, '0');
        if (fn === 'slug') {
          const s = slug(v);
          if (!s) warnings.push(`the id is a hash, not a name: "${name}" (${v}) has no Latin letters or digits to make one from — pass --id for a readable one`);
          return s || hash(v);
        }
        throw new DtError(`${c.name}: its id rule uses the filter "${fn}", which this engine does not have — pass --id`);
      }, String(raw));
    });
    if (ok) return id;
  }
  const needs = [...new Set(c.ids.from.flatMap((t) => [...t.matchAll(/\{\{\s*(\w+)/g)].map((m) => m[1])))].filter((n) => n !== 'created');
  throw new DtError(`${c.name}: cannot make an id — give ${needs.join(' or ')}, or pass --id`);
}

// ---- writes ------------------------------------------------------------------------------------------

export function add(model: Model, collection: string, input: Record<string, unknown>, id?: string): DtRecord {
  const c = coll(model, collection), bf = bodyField(c), warnings: string[] = [];
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null) data[k] = c.fields[k]?.many && !Array.isArray(v) ? [v] : v;
  data.created ??= stamp();
  for (const [name, f] of Object.entries(c.fields)) if (f.default !== undefined && data[name] === undefined) data[name] = f.default;
  const newId = id ?? makeId(c, data, warnings);
  if (existsSync(fileOf(model, c, newId))) throw new DtError(`${c.name}/${newId} already exists — nothing written`);
  let body = bf && typeof data[bf] === 'string' ? data[bf] as string : '';
  if (body && !body.endsWith('\n')) body += '\n';
  const front = Object.fromEntries(Object.entries(data).filter(([k]) => !(c.storage.format === 'md' && k === bf)));
  write(model, c, newId, data, compose(c, yamlOf(front), data, body), undefined);
  return { ...get(model, `${c.name}/${newId}`), ...(warnings.length ? { warnings } : {}) };
}

/** `null` or an empty string clears a field; a field with a default goes back to it */
export function set(model: Model, ref: string, changes: Record<string, unknown>): DtRecord {
  const { rec, c, doc, front, body: before } = load(model, ref);
  const bf = c.storage.format === 'md' ? bodyField(c) : undefined, data = { ...rec.data }, edits: [string, unknown][] = [];
  let body = before;
  for (const [k, raw] of Object.entries(changes)) {
    const cleared = raw === null || raw === '';
    const v = cleared ? c.fields[k]?.default : c.fields[k]?.many && !Array.isArray(raw) ? [raw] : raw;
    if (v === undefined) delete data[k]; else data[k] = v;
    if (k === bf) body = typeof v === 'string' && v ? (v.endsWith('\n') ? v : v + '\n') : '';
    else edits.push([k, v]);
  }
  const fields = Object.fromEntries(Object.entries(data).filter(([k]) => k !== bf));
  // edit the lines that change; if the result would not read back as the fields meant, write the fields afresh
  let yaml = doc ? editYaml(front, doc, edits) : null;
  if (doc && (yaml === null || !holds(yaml, fields))) yaml = yamlOf(fields);
  write(model, c, rec.id, data, compose(c, yaml ?? '', data, body), rec.mtimeMs);
  return get(model, rec.ref);
}

/** the records that hold a reference to this one */
export function referrers(model: Model, ref: string): string[] {
  const out: string[] = [];
  for (const c of Object.values(model.collections)) {
    const fields = Object.entries(c.fields).filter(([, f]) => isRef(f) && !f.mirror_of).map(([n]) => n);
    if (c.storage.format === 'binary' || !fields.length) continue;
    let ids: string[];
    try { ids = listIds(model, c.name); } catch { continue; }
    for (const id of ids) {
      let data: Record<string, unknown>;
      try { data = get(model, `${c.name}/${id}`).data; } catch { continue; }
      if (`${c.name}/${id}` !== ref && fields.some((n) => [data[n]].flat().includes(ref))) out.push(`${c.name}/${id}`);
    }
  }
  return out;
}

/** Refuses when other records point at this one, or when its folder holds other records — unless forced. */
export function rm(model: Model, ref: string, force = false): string {
  const { c, id, path } = locate(model, ref);
  const full = `${c.name}/${id}`, folder = c.storage.shape === 'folder';
  if (!force) {
    const by = referrers(model, full);
    if (by.length) throw new DtError(`${full} is referenced by ${by.length} record(s) — nothing removed; fix them, or pass --force:\n  ${by.join('\n  ')}`);
    const all = Object.values(model.collections).filter((o) => o.storage.format !== 'binary');
    const inside = folder ? walkFiles(dirname(path)).filter((p) => p !== path && all.some((o) => o.storage.shape === 'folder' ? basename(p) === entryOf(o) : p.endsWith(tail(o)))) : [];
    if (inside.length) throw new DtError(`${full} holds ${inside.length} other record(s) inside its folder — nothing removed; move them, or pass --force:\n  ${inside.map((p) => relative(model.root, p)).join('\n  ')}`);
  }
  rmSync(folder ? dirname(path) : path, { recursive: true });
  return full;
}

/** validate every record of every collection, and report the files no collection recognises; never modifies anything */
export function check(model: Model): { records: number; issues: Issue[] } {
  const issues: Issue[] = [...model.issues], unresolved = new Map<string, number>();
  const stored = Object.values(model.collections).filter((c) => !isAbsolute(c.storage.path)).map((c) => ({ c, base: join(model.root, c.storage.path) }));
  // a file belongs to a collection when it sits in the collection's folder and is named as its records are;
  // anything inside a folder-shaped collection belongs to its record
  const claimed = (p: string) => stored.some(({ c, base }) => p.startsWith(base + sep) && (c.storage.shape === 'folder' || c.storage.format === 'binary' || p.endsWith(tail(c))));
  const strays = new Set<string>();
  let records = 0;
  for (const { c, base } of stored) {
    if (c.storage.format === 'binary') { if (existsSync(base)) issues.push({ severity: 'warning', where: c.name, message: 'binary storage is not supported — its files are not checked' }); continue; }
    let ids: string[];
    try { ids = listIds(model, c.name); } catch (e) { issues.push({ severity: 'error', where: c.name, message: `cannot read ${c.storage.path}: ${(e as Error).message}` }); continue; }
    for (const id of ids) {
      records++;
      try { issues.push(...validate(model, c.name, id, get(model, `${c.name}/${id}`).data, unresolved)); }
      catch (e) { issues.push({ severity: 'error', where: `${c.name}/${id}`, message: (e as Error).message.replace(`${c.name}/${id}: `, '') }); }
    }
    // the released engine's system collections name source folders (modules/, skills/ …): what is there is source, not records
    const data = c.storage.shape !== 'folder' && !SOURCE_FOLDERS.has(c.storage.path) && resolve(base) !== resolve(model.root);
    if (data && existsSync(base)) for (const p of walkFiles(base)) if (!claimed(p) && !strays.has(p) && strays.add(p))
      issues.push({ severity: 'warning', where: relative(model.root, p), message: `unrecognized file in the ${c.name} folder — a record there is named <id>${tail(c)}` });
  }
  for (const [name, n] of unresolved) issues.push({ severity: 'warning', where: name, message: `a peer collection that is declared and not installed — ${n} reference(s) to it cannot be resolved` });
  return { records, issues };
}
