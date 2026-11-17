// CLI adapter: argument parsing and printing only — every rule lives behind api.ts.
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { DtError, add, buildModel, check, compile, get, listIds, rm, set } from './api.ts';

function parseArgs(argv: string[]) {
  const pos: string[] = [], fields: Record<string, unknown> = {}, opts: Record<string, string> = {};
  const put = (k: string, raw: string) => {
    const v = raw === '' ? '' : parse(raw);
    fields[k] = k in fields ? [fields[k]].flat().concat(v) : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-w' || a === '--workspace' || a === '--id') opts[a.replace(/^-+/, '')] = argv[++i];
    else if (a === '--json') opts.json = '1';
    else if (a.startsWith('--')) put(a.slice(2).replace(/-/g, '_'), argv[++i] ?? '');
    else if (/^[\w-]+=/.test(a) && pos.length >= 2) put(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
    else pos.push(a);
  }
  return { pos, fields, opts };
}

export function main(argv: string[]): number {
  const { pos: [verb, target], fields, opts } = parseArgs(argv);
  const model = buildModel(resolve(opts.w ?? opts.workspace ?? process.cwd()));
  const out = (v: unknown) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  try {
    switch (verb) {
      case 'modules': model.modules.forEach((m) => out(`${m.name}@${m.version} [${m.origin}]${m.unsupported.length ? ` — not implemented here: ${m.unsupported.join(', ')}` : ''}`)); break;
      case 'collections': Object.values(model.collections).forEach((c) => out(`${c.name} (${c.module}) — ${Object.keys(c.fields).length} fields`)); break;
      case 'list': listIds(model, target).forEach((id) => out(id)); break;
      case 'get': out(opts.json ? get(model, target) : get(model, target).data); break;
      case 'add': { const r = add(model, target, fields, opts.id); out(`✔ ${r.ref} · ${r.path}`); break; }
      case 'set': { const r = set(model, target, fields); out(`✔ ${r.ref} · ${r.path}`); break; }
      case 'rm': out(`✔ removed ${rm(model, target)}`); break;
      case 'compile': compile(model).forEach((f) => out(`✔ ${f}`)); break;
      case 'check': {
        const { records, issues } = check(model);
        issues.forEach((i) => out(`${i.severity === 'error' ? '✖' : '⚠'} ${i.where}: ${i.message}`));
        const errors = issues.filter((i) => i.severity === 'error').length;
        out(`${records} records · ${Object.keys(model.collections).length} collections · ${model.modules.length} modules · ${errors} errors · ${issues.length - errors} warnings`);
        return errors ? 1 : 0;
      }
      default: out('dt modules | collections | list <collection> | get <ref> | add <collection> --field value… [--id x] | set <ref> field=value… | rm <ref> | check | compile   [-w <workspace>]'); return verb ? 2 : 0;
    }
    return 0;
  } catch (e) {
    if (!(e instanceof DtError)) throw e;
    console.error(`✖ ${e.message}`);
    e.issues.forEach((i) => console.error(`  ${i.where}: ${i.message}`));
    return 1;
  }
}
