// Discovery: which modules does this workspace have? npm is the delivery mechanism; we only read.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DtError } from './types.ts';
import type { Module, Issue } from './types.ts';

/** manifest keys a module may carry that this engine sees and does not act on */
const NOT_ACTED_ON = ['extension', 'nav', 'setup', 'preset', 'env', 'engine', 'ignore', 'vars'];

function toModule(dir: string, origin: Module['origin'], issues: Issue[]): Module | null {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  let pkg: any;
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); }
  catch (e) { issues.push({ severity: 'error', where: pkgPath, message: `unreadable package.json: ${(e as Error).message}` }); return null; }
  const dt = pkg.dreamteamer;
  if (dt === undefined || dt === null || typeof dt !== 'object') return null;
  return {
    name: pkg.name, version: pkg.version ?? '0.0.0', dir, origin, title: dt.title,
    namespaces: dt.namespaces ?? [], dependencies: dt.dependencies ?? [], peers: dt.peer_collections ?? [],
    unsupported: NOT_ACTED_ON.filter((k) => dt[k] !== undefined),
  };
}

export function discover(root: string): { modules: Module[]; issues: Issue[]; config: any } {
  const rootPkg = join(root, 'package.json');
  if (!existsSync(rootPkg)) throw new DtError(`not a workspace: ${root} has no package.json`);
  let pkg: any;
  try { pkg = JSON.parse(readFileSync(rootPkg, 'utf8')); }
  catch (e) { throw new DtError(`not a workspace: ${rootPkg} is unreadable — ${(e as Error).message}`); }
  const config = pkg.dreamteamer ?? {};
  const disabled = new Set<string>(config.disable ?? []);
  const issues: Issue[] = [];
  const modules: Module[] = [];
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
  for (const dep of deps) {
    if (disabled.has(dep)) continue;
    const dir = join(root, 'node_modules', dep);
    if (!existsSync(dir)) { issues.push({ severity: 'error', where: dep, message: 'declared in package.json but not installed — run npm install' }); continue; }
    const m = toModule(dir, 'npm', issues);
    if (m) modules.push(m);
  }
  const local = join(root, 'modules');
  if (existsSync(local)) for (const name of readdirSync(local).sort()) {
    const m = toModule(join(local, name), 'workspace', issues);
    if (m) modules.push(m);
  }
  if (!modules.length && !issues.length) throw new DtError(`not a workspace: ${root} has no dreamteamer module among its dependencies or under modules/`);
  const names = new Set(modules.map((m) => m.name));
  for (const m of modules) for (const d of m.dependencies) if (!names.has(d)) {
    const present = existsSync(join(root, 'node_modules', d));
    issues.push({ severity: 'error', where: m.name, message: present
      ? `depends on module ${d}, which is in node_modules but not listed in this workspace's package.json — npm install --save-exact ${d}`
      : `depends on module ${d}, which is not installed` });
  }
  // workspace settings the released engine honours and this one does not: say so once, in check
  if (config.data_path && config.data_path !== 'data') issues.push({ severity: 'warning', where: 'package.json', message: `dreamteamer.data_path "${config.data_path}" is not honoured — records are stored where each descriptor says` });
  if (config.git_modules && Object.keys(config.git_modules).length) issues.push({ severity: 'warning', where: 'package.json', message: 'dreamteamer.git_modules is not honoured — record layers and git-delivered modules are not read' });
  return { modules, issues, config };
}
