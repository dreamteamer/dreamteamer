// The shipped nav fragments (cr-dt-008, design §3–4): a module names a nav.yaml of its own in
// `dreamteamer.nav`, and after an install or an update the workspace's nav.yaml gains the rows that
// fragment places and the document does not — never a row the operator already placed, hid or moved.
//
// Workspace layer: which package a fragment comes from, and whether it may place a collection, is a
// question about modules. The rule is owns-or-overlays — a module places only collections it owns or
// overlays, a module preset only its members' — so a fragment can never draw another module's rows in
// its own folder. A name no installed module owns is dropped without a word: it is a preset member the
// operator removed, and it is placed once its owner is installed again.
//
// Old nav settings (`dreamteamer.navGroups` / `navOrder` / `navHidden` in .vscode/settings.json) with no
// nav.yaml mean the workspace still draws by those: the merge skips, and install and update refuse
// before npm (`navGuard`) until the settings are migrated or `--allow nav-reset` says to start fresh.
import fs from 'node:fs';
import path from 'node:path';
import { discoverModules, moduleIdOf } from './compile.js';
import { loadDescriptors } from './runtime.js';
import { moduleOf, overlaidByOf } from './descriptor.js';
import { findWorkspace } from './workspace.js';
import { parseNavDoc, readNavDoc, writeNavDoc, placedNames, mergeFragment, NavDocError, NAV_FILE } from './nav.js';

export const NAV_SETTINGS_LINE = 'nav: settings found, migrated on the next open of the editor or dt web';
export const NAV_GUARD_LINE = 'your nav settings are not saved to nav.yaml yet — run: npx -p @dreamteamer/protocol@0.2 dt-nav migrate (or open this workspace once in the editor 0.26 or later), then run this again; --allow nav-reset skips it';
const NAV_KEYS = ['dreamteamer.navGroups', 'dreamteamer.navOrder', 'dreamteamer.navHidden'];

export class NavFragmentRefusal extends Error {
	constructor(message) {
		super(message);
		this.name = 'NavFragmentRefusal';
	}
}

/** JSON with comments and trailing commas (what VS Code writes) as plain JSON text. Strings are kept
 *  whole: a `//` or a `,]` inside one is data. */
function stripJsonc(text) {
	const scan = (src, step) => {
		let out = '';
		for (let i = 0; i < src.length; i++) {
			if (src[i] === '"') {
				let j = i + 1;
				while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
				out += src.slice(i, j + 1);
				i = j;
			} else {
				const r = step(src, i);
				out += r.text;
				i = r.at;
			}
		}
		return out;
	};
	const noComments = scan(text, (src, i) => {
		if (src[i] === '/' && src[i + 1] === '/') { let j = i; while (j < src.length && src[j] !== '\n') j++; return { text: '\n', at: j }; }
		if (src[i] === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); return { text: ' ', at: end === -1 ? src.length : end + 1 }; }
		return { text: src[i], at: i };
	});
	return scan(noComments, (src, i) => (src[i] === ',' && /^\s*[}\]]/.test(src.slice(i + 1)) ? { text: '', at: i } : { text: src[i], at: i }));
}

/** The old nav settings this workspace still sets — the names among navGroups, navOrder and navHidden
 *  whose value is a non-empty list or map — or null. An absent or unparseable file is null;
 *  `layersFolder` is never one of them. */
export function navSettings(root) {
	let settings;
	try {
		settings = JSON.parse(stripJsonc(fs.readFileSync(path.join(root, '.vscode', 'settings.json'), 'utf8')));
	} catch { return null; }
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
	const set = NAV_KEYS.filter((k) => {
		const v = settings[k];
		if (Array.isArray(v)) return v.length > 0;
		return v !== null && typeof v === 'object' && Object.keys(v).length > 0;
	});
	return set.length ? set : null;
}

/** The refusal install and update print before npm, or null: nav.yaml absent and old nav settings set. */
export function navGuard(root) {
	if (fs.existsSync(path.join(root, NAV_FILE))) return null;
	return navSettings(root) ? NAV_GUARD_LINE : null;
}

/**
 * The refusal install and update print before npm when the workspace's nav.yaml does not read, or null.
 * Asked only when a package of the call ships a fragment (`shipsFragment`): a call that ships none merges
 * nothing and never reads the file, so a malformed nav.yaml blocks only the installs that would merge into it.
 */
export function navDocGuard(root) {
	try { readNavDoc(root); return null; } catch (e) {
		if (e instanceof NavDocError) return e.message;
		throw e;
	}
}

/** Whether any package of a resolved list ships a nav fragment (`dreamteamer.nav`). */
export const shipsFragment = (list) => list.some((e) => e.manifest?.dreamteamer?.nav);

const readPkg = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } };

/**
 * The merged document install and update write — or a refusal. `ws` is a compiled handle; `names` are
 * package names (default every discovered module). Every fragment is judged before anything merges,
 * so one bad fragment refuses the whole call. Returns `{ doc, placed, changed }`, or
 * `{ doc: null, placed: [], changed: false, skipped: 'settings' }` while old nav settings stand.
 */
export function planNavFragments(ws, { names, ignoreSettings = false } = {}) {
	const { modules } = discoverModules(ws.root, ws.pkg);
	const byName = new Map();
	for (const m of modules) byName.set(m.name, { ...m, manifest: readPkg(m.root) ?? {} });
	const byId = new Map([...byName.values()].map((m) => [moduleIdOf(m.name), m.name]));

	// a preset's reach: its members, flattened through nested presets (a seen-set stops a ring)
	const membersOf = (name, seen = new Set()) => {
		if (seen.has(name)) return [];
		seen.add(name);
		const preset = byName.get(name)?.manifest?.dreamteamer?.preset;
		if (!preset || typeof preset !== 'object') return [];
		return Object.keys(preset).flatMap((m) => [m, ...membersOf(m, seen)]);
	};

	const wanted = (names ?? [...byName.keys()]).filter((n) => byName.get(n)?.manifest?.dreamteamer?.nav);
	const isPreset = (n) => !!byName.get(n).manifest.dreamteamer.preset;
	const ordered = [...wanted.filter(isPreset), ...wanted.filter((n) => !isPreset(n))];

	const descriptors = loadDescriptors(ws.root) ?? new Map();
	const kept = [];
	for (const pkgName of ordered) {
		const m = byName.get(pkgName);
		const reach = isPreset(pkgName) ? membersOf(pkgName) : [pkgName];
		const allowed = new Set(reach.map(moduleIdOf));
		const declared = new Set(reach.flatMap((n) => byName.get(n)?.manifest?.dreamteamer?.namespaces ?? []));
		let fragment;
		try {
			fragment = parseNavDoc(fs.readFileSync(path.join(m.root, m.manifest.dreamteamer.nav), 'utf8'));
		} catch (e) {
			if (e instanceof NavDocError) throw new NavFragmentRefusal(`nav.yaml of ${pkgName}: ${e.message}`);
			throw new NavFragmentRefusal(`nav.yaml of ${pkgName}: ${m.manifest.dreamteamer.nav} could not be read — ${e.code === 'ENOENT' ? 'the package does not ship it' : e.message}`);
		}
		const judge = (items) => {
			const out = [];
			for (const e of Array.isArray(items) ? items : []) {
				const c = typeof e === 'string' ? e : (e && typeof e.collection === 'string' ? e.collection : null);
				if (c !== null) {
					const d = descriptors.get(c);
					if (!d) continue; // nothing installed owns it — a removed member; placed once it is back
					if (!allowed.has(moduleOf(d)) && !overlaidByOf(d).some((id) => allowed.has(id))) {
						const owner = byId.get(moduleOf(d)) ?? 'the engine';
						throw new NavFragmentRefusal(`nav.yaml of ${pkgName} places ${c}, which ${owner} owns`);
					}
					out.push(e);
				} else if (e && typeof e.folder === 'string') {
					out.push({ ...e, items: judge(e.items) });
				} else if (e && typeof e.namespace === 'string') {
					if (!declared.has(e.namespace)) throw new NavFragmentRefusal(`nav.yaml of ${pkgName} places namespace ${e.namespace}, which ${pkgName} does not declare`);
					out.push(Array.isArray(e.items) ? { ...e, items: judge(e.items) } : e);
				}
			}
			return out;
		};
		kept.push({ tree: judge(fragment.tree), hidden: [] });
	}

	if (!ignoreSettings && !fs.existsSync(path.join(ws.root, NAV_FILE)) && navSettings(ws.root)) {
		return { doc: null, placed: [], changed: false, skipped: 'settings' };
	}
	// no fragment among the packages: nothing merges, and the workspace's nav.yaml is never read
	if (!kept.length) return { doc: null, placed: [], changed: false };
	const start = readNavDoc(ws.root) ?? { tree: [], hidden: [] };
	let doc = start;
	const placed = [];
	for (const f of kept) {
		const r = mergeFragment(doc, f, { placed: placedNames(doc) });
		doc = r.doc;
		placed.push(...r.placedNow);
	}
	return { doc, placed, changed: doc !== start };
}

/**
 * The installed fragments merged into `<root>/nav.yaml`, written when anything was placed. What a host
 * calls after its own settings migration; install and update run the same plan inside their compile
 * step. Throws NavFragmentRefusal (and a NavDocError for a nav.yaml it cannot read) and writes nothing.
 */
export function applyNavFragments(root, { names, ignoreSettings = false } = {}) {
	const found = findWorkspace(root);
	const plan = planNavFragments({ root: found.root, pkg: found.pkg }, { names, ignoreSettings });
	if (plan.skipped) return { written: false, placed: [], skipped: plan.skipped };
	if (plan.changed) writeNavDoc(found.root, plan.doc);
	return { written: plan.changed, placed: plan.placed };
}
