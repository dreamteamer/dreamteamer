// Discovery: which modules does this workspace have? npm is the delivery mechanism; we only read.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Module, Issue } from './types.ts';

const UNSUPPORTED_KEYS = ['extension', 'nav', 'setup', 'presets', 'peer_collections', 'ignore', 'vars'];

function readJson(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }

function toModule(dir: string, origin: Module['origin']): Module | null {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  const pkg = readJson(pkgPath);
  const dt = pkg.dreamteamer;
  if (dt === undefined || typeof dt !== 'object') return null;
  return {
    name: pkg.name, version: pkg.version ?? '0.0.0', dir, origin, title: dt.title,
    namespaces: dt.namespaces ?? [], dependencies: dt.dependencies ?? [],
    unsupported: UNSUPPORTED_KEYS.filter((k) => dt[k] !== undefined),
  };
}

export function discover(root: string): { modules: Module[]; issues: Issue[]; config: any } {
  const pkg = readJson(join(root, 'package.json'));
  const config = pkg.dreamteamer ?? {};
  const disabled = new Set<string>(config.disable ?? []);
  const issues: Issue[] = [];
  const modules: Module[] = [];
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
  for (const dep of deps) {
    if (disabled.has(dep)) continue;
    const dir = join(root, 'node_modules', dep);
    if (!existsSync(dir)) { issues.push({ severity: 'error', where: dep, message: 'declared in package.json but not installed — run npm install' }); continue; }
    const m = toModule(dir, 'npm');
    if (m) modules.push(m);
  }
  const local = join(root, 'modules');
  if (existsSync(local)) for (const name of readdirSync(local).sort()) {
    const m = toModule(join(local, name), 'workspace');
    if (m) modules.push(m);
  }
  const names = new Set(modules.map((m) => m.name));
  for (const m of modules) for (const d of m.dependencies) if (!names.has(d))
    issues.push({ severity: 'error', where: m.name, message: `depends on module ${d}, which is not installed` });
  return { modules, issues, config };
}
