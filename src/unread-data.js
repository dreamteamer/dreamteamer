// Record files under the workspace's own data/ that no compiled collection reads (cr-dt-008 test stage).
//
// A collection that leaves a module — notebooks and wikis composed out of rnd — leaves its records on disk
// with nothing reading them, and `dt check` said "0 violations". Compile has warned about the same thing for
// a record layer's clone since cr-dt-004 ("no collection here reads it"); this is the workspace's own data/,
// read at check time against the compiled descriptors. A warning, never a violation: the files are not
// wrong, they are unread — and the remedy is usually one install.
//
// Workspace layer: naming the package that would read a folder is a question about packages.
import fs from 'node:fs';
import path from 'node:path';
import { load } from './yaml.js';
import { loadDescriptors, exportsFacts } from './runtime.js';
import { storageOf } from './descriptor.js';
import { defaultStoragePath } from './namespace.js';
import { walk } from './records.js';
import { discoverModules, kindDir } from './compile.js';

/** `<id>.<suffix>.<ext>` — the shape every text record file has (a dotfile never is one). */
const RECORD_FILE = /^[^.][^/]*\.[A-Za-z][\w-]*\.(md|ya?ml|json)$/;
const subdirs = (abs) => { try { return fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { return []; } };

/** `[folder, files]` per folder under `dataDir` no claimed path accounts for and holding record files:
 *  a claimed folder is skipped, a prefix of one (a namespace folder) is descended into. `/`-joined. */
export function unreadRecordFolders(root, dataDir, claimed) {
	const out = [];
	const visit = (rel) => {
		for (const name of subdirs(path.join(root, rel))) {
			const p = `${rel}/${name}`;
			if (claimed.has(p)) continue;
			if ([...claimed].some((c) => c.startsWith(`${p}/`))) { visit(p); continue; }
			const files = [...walk(path.join(root, p))].map((f) => path.relative(path.join(root, p), f).split(path.sep).join('/')).filter((f) => RECORD_FILE.test(path.posix.basename(f))).sort();
			if (files.length) out.push([p, files]);
		}
	};
	visit(dataDir);
	return out;
}

/** The folder each collection of a package in node_modules that this workspace does not compile would
 *  store its records in, as `folder → "<package> defines <collection>"` — where an unread folder's reader is. */
function definedFolders(ws, dataDir) {
	const nm = path.join(ws.root, 'node_modules');
	const compiled = new Set(discoverModules(ws.root, ws.pkg).modules.map((m) => m.name));
	const at = new Map();
	for (const top of subdirs(nm)) {
		for (const dir of top.startsWith('@') ? subdirs(path.join(nm, top)).map((s) => path.join(nm, top, s)) : [path.join(nm, top)]) {
			let m;
			try { m = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
			if (!m.dreamteamer || compiled.has(m.name) || !fs.existsSync(kindDir(dir, 'collections'))) continue;
			for (const f of [...walk(kindDir(dir, 'collections'))].filter((x) => x.endsWith('.collection.yaml'))) {
				let d;
				try { d = load(fs.readFileSync(f, 'utf8')); } catch { continue; }
				const literal = typeof d?.storage?.path === 'string' && !d.storage.path.includes('${');
				if (typeof d?.name === 'string') at.set(literal ? d.storage.path.replace(/\/+$/, '') : defaultStoragePath(d.name, m.dreamteamer.namespaces ?? [], dataDir), `${m.name} defines ${d.name}: dt install ${m.name}`);
			}
		}
	}
	return at;
}

/** The ⚠ lines `dt check` prints, as `{ file, msg, warning: true }` items (src/api.js contributedViolations). */
export function unreadDataWarnings(ws) {
	const descriptors = loadDescriptors(ws.root) ?? new Map();
	const dataDir = exportsFacts(ws.root).data;
	const roots = [...descriptors.values()].map(storageOf).filter((s) => !s.runtime && !s.external && !s.unavailable && !path.isAbsolute(s.path));
	const unread = unreadRecordFolders(ws.root, dataDir, new Set(roots.map((s) => s.path.replace(/\/+$/, ''))));
	const known = unread.length ? definedFolders(ws, dataDir) : new Map();
	return unread.map(([folder, files]) => {
		const shown = files.length > 3 ? [...files.slice(0, 3), `+${files.length - 3} more`] : files;
		const msg = `${files.length} record file${files.length === 1 ? '' : 's'} no collection here reads (${shown.join(', ')}) — ${known.get(folder) ?? 'install the module that defines it to read them'}`;
		return { file: `${folder}/`, msg, warning: true };
	});
}
