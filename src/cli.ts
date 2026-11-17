// CLI adapter: reads the command line and prints. A value is converted by the declared type of its field;
// every rule about records lives behind api.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { DtError, add, buildModel, check, compile, findCollection, get, list, rm, set, splitRef } from './api.ts';
import type { Collection, Field, Model } from './api.ts';

const USAGE = `usage: <verb> [target] [arguments] [-w <workspace>]
  modules                                  the modules this workspace has
  collections                              the collections they define
  list <collection> [--filter <field>=<value>]… [--json]
  get <ref> [--json]
  add <collection> ["<title>"] --<field> <value>… [--id <id>]
  set <ref> <field>=<value>…               an empty value clears a field
  rm <ref> [--force]
  check                                    validate every record; changes nothing
  compile                                  write .dt/AGENTS.md and .dt/model.json
  help | --version`;
const VERBS: Record<string, string[]> = { modules: [], collections: [], list: ['filter', 'json'], get: ['json'], add: ['id'], set: [], rm: ['force'], check: [], compile: [] };

interface Args { pos: string[]; opts: Record<string, string[]>; fields: [string, string | undefined][] }

/** `--name value`, `--name=value`, a bare `--flag`, and `name=value`; the verb's own options are kept apart from fields */
function parseArgs(verb: string, rest: string[]): Args {
  const a: Args = { pos: [], opts: {}, fields: [] };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    let key: string, value: string | undefined;
    if (t.startsWith('--') && t.length > 2) {
      const eq = t.indexOf('=');
      key = eq < 0 ? t.slice(2) : t.slice(2, eq);
      value = eq >= 0 ? t.slice(eq + 1) : rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') && !['json', 'force'].includes(key) ? rest[++i] : undefined;
    } else if (/^[A-Za-z_][\w.-]*=/.test(t) && (verb === 'add' || verb === 'set')) {
      key = t.slice(0, t.indexOf('=')); value = t.slice(t.indexOf('=') + 1);
    } else { a.pos.push(t); continue; }
    if (VERBS[verb].includes(key)) (a.opts[key] ??= []).push(value ?? 'true');
    else if (verb === 'add' || verb === 'set') a.fields.push([key, value]);
    else throw new DtError(`${verb} does not take --${key}${VERBS[verb].length ? ` — it takes ${VERBS[verb].map((o) => '--' + o).join(', ')}` : ''}`);
  }
  return a;
}

function one(type: Field['type'], raw: string, name: string): unknown {
  if (type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  if (type === 'integer' || type === 'number') return raw.trim() !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  if (type === 'object' || type === 'map') {
    try { return parse(raw); } catch (e) { throw new DtError(`${name}: a map is written as YAML or JSON, such as '{city: Paris}' — ${(e as Error).message.split('\n')[0]}`); }
  }
  // a bare id on a field that points at one collection is qualified for you
  if (typeof type === 'string' && !['string', 'markdown', 'url', 'email', 'date', 'datetime', 'position', 'reference'].includes(type) && !raw.startsWith(type + '/')) return `${type}/${raw}`;
  return raw;
}

/** the fields given on the command line, each converted by its declared type; `null` means "clear this field" */
function fieldValues(c: Collection, given: [string, string | undefined][]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [typed, raw] of given) {
    const name = c.fields[typed] || typed === 'created' ? typed : typed.replace(/-/g, '_');
    const f: Field | undefined = name === 'created' && !c.fields.created ? { type: 'datetime' } : c.fields[name];
    if (!f) {
      const near = Object.keys(c.fields).filter((k) => k.startsWith(typed.slice(0, 3)) || typed.startsWith(k));
      throw new DtError(`${c.name} has no field ${typed}${near.length ? ` — did you mean ${near.join(' or ')}?` : ''} Its fields are ${Object.keys(c.fields).join(', ')}`);
    }
    if (raw === undefined && f.type !== 'boolean') throw new DtError(`--${typed} needs a value`);
    const nested = f.type === 'object' || f.type === 'map';
    const values = raw === undefined ? [true] : raw === '' ? [null] : (f.many && !nested ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [raw]).map((v) => one(f.type, v, name));
    if (f.many) out[name] = values[0] === null ? null : [...(Array.isArray(out[name]) ? out[name] as unknown[] : []), ...values];
    else if (name in out) throw new DtError(`${name} is given twice, and it holds one value`);
    else out[name] = values[0];
  }
  return out;
}

const version = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function run(argv: string[], out: (v: unknown) => void): number {
  const args = [...argv];
  const w = args.findIndex((t) => t === '-w' || t === '--workspace');
  const root = resolve(w >= 0 ? args.splice(w, 2)[1] ?? '' : process.cwd());
  if (args.includes('--version')) { out(`dreamteamer-first-principles ${version()}`); return 0; }
  const verb = args.shift();
  if (!verb || verb === 'help' || verb === '--help') { out(USAGE); return 0; }
  if (verb.startsWith('-')) throw new DtError(`the verb comes first — got ${verb}\n${USAGE}`);
  if (!VERBS[verb]) { out(`unknown verb ${verb}\n${USAGE}`); return 2; }
  const { pos, opts, fields } = parseArgs(verb, args);
  const [target, ...extra] = pos;
  const model: Model = buildModel(root);
  const wanted = (what: string) => { if (!target) throw new DtError(`${verb} needs ${what}`); return target; };
  const noExtra = (n = 0) => { if (extra.length > n) throw new DtError(`${verb} does not take "${extra[n]}"`); };
  const none = () => { if (pos.length) throw new DtError(`${verb} does not take "${pos[0]}"`); };
  const collectionOf = (name: string) => { const c = findCollection(model, name); if (!c) throw new DtError(`unknown collection ${name} — the collections are ${Object.keys(model.collections).sort().join(', ')}`); return c; };
  const done = (r: { ref: string; path: string; warnings?: string[] }) => { out(`✔ ${r.ref} · ${r.path}`); r.warnings?.forEach((m) => out(`⚠ ${m}`)); };
  switch (verb) {
    case 'modules': none(); model.modules.forEach((m) => out(`${m.name}@${m.version} [${m.origin}]${m.unsupported.length ? ` — not acted on here: ${m.unsupported.join(', ')}` : ''}`)); return 0;
    case 'collections': none(); Object.values(model.collections).forEach((c) => out(`${c.name} (${c.module}) — ${Object.keys(c.fields).length} fields`)); return 0;
    case 'list': {
      noExtra();
      const where = Object.fromEntries((opts.filter ?? []).map((f) => { if (!f.includes('=')) throw new DtError(`--filter takes <field>=<value>, got "${f}"`); return [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)]; }));
      const records = list(model, wanted('a collection'), where);
      if (opts.json) out(records); else records.forEach((r) => out(r.id));
      return 0;
    }
    case 'get': noExtra(); out(opts.json ? get(model, wanted('a <collection>/<id> reference')) : get(model, wanted('a <collection>/<id> reference')).data); return 0;
    case 'add': {
      const c = collectionOf(wanted('a collection'));
      noExtra(1);
      // one bare argument is the record's title: its `name`, else its `title`, else its first required text field
      const title = ['name', 'title', ...Object.keys(c.fields).filter((k) => c.fields[k].required && c.fields[k].type === 'string')].find((k) => c.fields[k]);
      if (extra.length && !title) throw new DtError(`${c.name} has no title field to put "${extra[0]}" in — name the field`);
      done(add(model, c.name, fieldValues(c, [...(extra.length ? [[title!, extra[0]] as [string, string]] : []), ...fields]), opts.id?.[0]));
      return 0;
    }
    case 'set': {
      noExtra();
      const at = splitRef(model, wanted('a <collection>/<id> reference'), true);
      if (!at) throw new DtError(`${target}: not a <collection>/<id> reference`);
      if (!fields.length) throw new DtError('nothing to set — give <field>=<value> pairs');
      done(set(model, target, fieldValues(model.collections[at.collection], fields)));
      return 0;
    }
    case 'rm': noExtra(); out(`✔ removed ${rm(model, wanted('a <collection>/<id> reference'), Boolean(opts.force))}`); return 0;
    case 'compile': none(); compile(model).forEach((f) => out(`✔ ${f}`)); return 0;
    default: {
      none();
      const { records, issues } = check(model);
      issues.forEach((i) => out(`${i.severity === 'error' ? '✖' : '⚠'} ${i.where}: ${i.message}`));
      const errors = issues.filter((i) => i.severity === 'error').length;
      out(`${records} records · ${Object.keys(model.collections).length} collections · ${model.modules.length} modules · ${errors} errors · ${issues.length - errors} warnings`);
      return errors ? 1 : 0;
    }
  }
}

export function main(argv: string[]): number {
  try { return run(argv, (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))); }
  catch (e) {
    const err = e as Error & { issues?: { where: string; message: string }[] };
    console.error(`✖ ${err.message}`);
    err.issues?.forEach((i) => console.error(`  ${i.where}: ${i.message}`));
    if (!(e instanceof DtError) && process.env.DT_DEBUG) console.error(err.stack);
    return 1;
  }
}
