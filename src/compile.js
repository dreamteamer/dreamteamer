// dreamteamer compile — materialize (modules × workspace sources) into .dreamteamer,
// the single runtime read surface: copies + provenance manifest, then harness adapters.
// explicit only; nothing rebuilds implicitly.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { load, dump } from './yaml.js';
import { slug } from './template.js';
import { walk, patternRe } from './records.js';
import { unknownOperators } from './filter.js';
import {
	normalizeNamespaces, namespaceProblems, unqualifiedProblems, defaultStoragePath, storageOverlaps,
	baseNameOf, singular,
} from './namespace.js';
// circular on paper in earlier versions — safe: both sides only
// call at run time, same pattern as store.js ↔ compile.js.
import { runHarnessAdapters } from './harnesses.js';
import { satisfies } from './semver.js';
import { parseEnvValues } from './env-vars.js';
import { DERIVED_KINDS, readManifest, runtimeDir } from './runtime.js';

// re-exported, not moved: `readManifest` is in the VS Code extension's hand-maintained engine
// contract as `compileMod.readManifest` (engine.ts), and a removed export is the same cross-repo
// break as a removed file — decision 139.
export { readManifest };

/**
 * Identifier → display label: `finance-accounts` → "Finance Accounts".
 *
 * The ONE derivation of a label from an id. compile resolves it INTO the descriptor so that no
 * surface re-implements it — the same lesson as `storage.base`, which lived as a re-derived path
 * test in five places before it became a field. An authored `title` always wins over this.
 *
 * `/` is a separator because a collection id may contain one (`titles.ts` splits routes on that
 * assumption). Field names cannot, which is why the extension's browser-side copy of this rule
 * (`webview/src/lib/format-title.ts`, which cannot import node code) stays byte-compatible for the
 * only comparison that matters — the round-trip guard in schema-ops.js.
 */
export function titleCase(id) {
	return String(id)
		.split(/[_\-\s/]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

/**
 * Every `x-display` left in a schema, as `[fieldPath, template, referenceTarget|null]`.
 *
 * The keyword was renamed to `x-title-template` and mostly DELETED — its value is inherited from
 * the target collection's `title_template`. There is deliberately no alias: real workspaces pin
 * this engine by SHA, so nothing breaks until someone bumps a pin, and that person needs a message
 * rather than silence. JSON Schema IGNORES unknown keywords, so the alternative to failing here is
 * a label that quietly stops working and regresses to a raw id.
 */
function staleDisplayKeywords(schema, prefix = '') {
	const out = [];
	for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
		if (!prop || typeof prop !== 'object') continue;
		const at = `${prefix}${key}`;
		if ('x-display' in prop) out.push([at, prop['x-display'], prop['x-reference'] ?? null]);
		if (prop.items && typeof prop.items === 'object' && 'x-display' in prop.items) {
			out.push([at, prop.items['x-display'], prop.items['x-reference'] ?? null]);
		}
		if (prop.properties) out.push(...staleDisplayKeywords(prop, `${at}.`));
		if (prop.items?.properties) out.push(...staleDisplayKeywords(prop.items, `${at}[].`));
	}
	return out;
}

/**
 * Every `x-reference` in a schema, as `[fieldPath, target]` — the same traversal check.js uses to
 * resolve refs in records, here to verify the SHAPE against the module dependency graph. Nested
 * objects and array items both carry the keyword, so both are walked. `target` is the RAW keyword
 * value — a string, or a list of strings for the union form — unvalidated; the caller checks shape.
 */
function refTargets(schema, prefix = '') {
	const out = [];
	for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
		if (!prop || typeof prop !== 'object') continue;
		const at = `${prefix}${key}`;
		if (prop['x-reference']) out.push([at, prop['x-reference']]);
		if (prop.items && typeof prop.items === 'object' && prop.items['x-reference']) out.push([`${at}[]`, prop.items['x-reference']]);
		if (prop.properties) out.push(...refTargets(prop, `${at}.`));
		if (prop.items?.properties) out.push(...refTargets(prop.items, `${at}[].`));
	}
	return out;
}

/**
 * Hoist per-relation keywords onto the node that CARRIES `x-reference` — `items` for array fields.
 * Both places were historically tolerated and check.js read `s['x-inverse'] ?? s.items['x-inverse']`,
 * a two-place read every future consumer would have had to copy. After this, every runtime consumer
 * reads exactly one place. Conflicting duplicates fail loudly: silently preferring one is how a
 * hand-authored value gets shadowed with no error anywhere.
 */
function normalizeRelationKeywords(schema, name, prefix = '') {
	for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
		if (!prop || typeof prop !== 'object') continue;
		const at = `${prefix}${key}`;
		if (prop.items && typeof prop.items === 'object' && prop.items['x-reference']) {
			// every per-relation keyword, not just `x-inverse` — `x-unique` decides the mirror's
			// cardinality, `x-on-delete` its removal rule and `x-inverse-of` names the owner from the
			// other spelling, so all four have to reach the same node the relation is read from.
			for (const kw of ['x-inverse', 'x-title-template', 'x-unique', 'x-on-delete', 'x-inverse-of', 'x-reference-soft']) {
				if (!(kw in prop)) continue;
				if (kw in prop.items && prop.items[kw] !== prop[kw]) {
					fail(`collection "${name}": field "${at}" declares conflicting ${kw} on the property and its items — keep one.`);
				}
				prop.items[kw] = prop[kw];
				delete prop[kw];
			}
		}
		if (prop.properties) normalizeRelationKeywords(prop, name, `${at}.`);
		if (prop.items?.properties) normalizeRelationKeywords(prop.items, name, `${at}[].`);
	}
}

/** The properties a `codec: md` record's PROSE lands in — `x-body`, of which there may be at most
 *  one. `store.js`'s `bodyField(d)` is the record-layer spelling of the same question, and it takes
 *  the FIRST such property; compile is what guarantees there is never a second, and it needs the
 *  answer before a Store exists. Every place compile asks it reads through here. */
function bodyKeys(schema) {
	return Object.entries(schema?.properties ?? {}).filter(([, s]) => s?.['x-body'] === true).map(([k]) => k);
}

/** Fold the mirror-authoring side of a relation into its OWNER: cardinality closes backwards, the
 *  authored description rides along on the owner's `x-inverse`, and the field itself goes — pass 2
 *  puts a generated one back under the same key, which is also what keeps field ORDER identical
 *  across spellings (a surviving key would keep its authored position; a deleted one is appended).
 *  Both legacy spellings land here, and that is WHY they compile to identical bytes: one code path,
 *  not two that have to be kept in step by hand. */
function foldMirrorSide(d, name, field, prop, oHolder, of) {
	// cardinality closes backwards: a scalar mirror means the FK is unique
	if (prop.type !== 'array') oHolder['x-unique'] = true;
	else if (oHolder['x-unique'] === true) fail(`collection "${name}": field "${field}" is an array mirror of the unique FK "${of}" — one of the two is wrong.`);
	// the owner's own object-form description survives only where the folded side has none: prose
	// describing the MIRROR was written on the mirror, so it is the more specific of the two.
	const own = oHolder['x-inverse'];
	const description = typeof prop.description === 'string' ? prop.description : (typeof own === 'object' ? own?.description : undefined);
	oHolder['x-inverse'] = description === undefined ? field : { field, description };
	delete d.schema.properties[field];
}

/** Two source spellings, one compiled pair. Spelling B (`x-inverse-of` on the non-owning side)
 *  is rewritten onto the owner as `x-inverse`; then every owner `x-inverse` stamps a generated
 *  readOnly mirror on its target. Runs over ALL merged descriptors because a relation spans two. */
function materializeRelations(mergedGroups, ctx) {
	const byName = new Map([...mergedGroups].map(([n, g]) => [n, g.merged]));
	// ---- pass 1: spelling B → canonical A on the owner --------------------------------
	for (const [name, d] of byName) {
		for (const [field, prop] of Object.entries(d.schema?.properties ?? {})) {
			if (!prop || typeof prop !== 'object') continue;
			const holder = (prop.items && typeof prop.items === 'object') ? prop.items : prop;
			const of = holder['x-inverse-of'];
			if (!of) continue;
			const dot = of.lastIndexOf('.'); // collection names contain '/', so split at the LAST dot
			if (dot < 1) fail(`collection "${name}": field "${field}" has x-inverse-of "${of}" — expected <collection>.<field>.`);
			const ownerName = of.slice(0, dot), ownerField = of.slice(dot + 1);
			const owner = byName.get(ownerName);
			const oProp = owner?.schema?.properties?.[ownerField];
			// The two halves of "<collection>.<field>" fail differently, and saying "no such field"
			// for a mistyped COLLECTION sends the reader to inspect a field that is spelled correctly.
			if (!owner) fail(`collection "${name}": field "${field}" declares x-inverse-of "${of}" — there is no collection "${ownerName}" (have: ${[...byName.keys()].sort().join(', ')}).`);
			if (!oProp) fail(`collection "${name}": field "${field}" declares x-inverse-of "${of}", but ${ownerName} has no field "${ownerField}".`);
			const oHolder = (oProp.items && typeof oProp.items === 'object') ? oProp.items : oProp;
			const oTargets = refTargets(owner.schema).find(([at]) => at === ownerField || at === `${ownerField}[]`);
			const targetList = oTargets ? (Array.isArray(oTargets[1]) ? oTargets[1] : [oTargets[1]]) : [];
			if (!targetList.includes(name)) fail(`collection "${name}": x-inverse-of "${of}" — that field does not reference ${name}.`);
			const existing = oHolder['x-inverse'];
			const existingName = existing && (typeof existing === 'string' ? existing : existing.field);
			if (existingName && existingName !== field) fail(`relation ${of}: declared on both sides and they disagree ("${existingName}" vs "${field}") — keep one.`);
			if (existingName) console.warn(`⚠ relation ${of}: declared on both sides — keep one (x-inverse on the owner, or x-inverse-of on ${name}.${field}).`);
			// the authored spelling-B field is replaced by the generated mirror in pass 2
			foldMirrorSide(d, name, field, prop, oHolder, of);
		}
	}
	// ---- pass 1b: the legacy MUTUAL spelling — both sides declaring x-inverse at each other ----
	// ONE edge described twice, not two edges. It is the shape 0.14's docs taught, and real
	// workspaces still carry it; read as two relations, each side's mirror lands on the other's
	// authored field and compile dies on a collision the author cannot act on — while the design doc
	// promises the legacy shape keeps compiling for one minor. So collapse it here, warn ONCE per
	// pair, and hand pass 2 exactly what the single-sided spelling would have handed it.
	// EVERY source a collection is compiled from, not `sources[0]`. A collection assembled from a base
	// plus an `extends:` overlay (or a `templates:` field set) has several descriptor files, and the
	// field this warning tells you to delete may be authored in ANY of them — naming the first is a
	// guess, and following a wrong guess means editing a file that does not contain the field,
	// changing nothing, and finding the same warning still there next compile. So list them all and
	// let the author look: two paths to check beats one that is confidently wrong.
	const srcsOf = (n) => {
		const paths = [...new Set((mergedGroups.get(n)?.sources ?? []).map((s) => s?.path).filter(Boolean))];
		if (paths.length === 0) return n;
		return paths.length === 1 ? paths[0] : `one of ${paths.join(', ')}`;
	};
	for (const [name, d] of byName) {
		for (const [field, prop] of Object.entries(d.schema?.properties ?? {})) {
			// `field in properties` re-checked because a MUTUAL SELF-REFERENCE (companies.parent ⟷
			// companies.subsidiaries) folds one of the two fields away while this snapshot is still
			// being walked — without it the pair would be collapsed a second time, from the other end,
			// and the surviving owner would be folded into the field it just replaced.
			if (!prop || typeof prop !== 'object' || !(field in d.schema.properties)) continue;
			const holder = (prop.items && typeof prop.items === 'object') ? prop.items : prop;
			const inv = holder['x-inverse'];
			if (!inv) continue;
			const mirror = typeof inv === 'string' ? inv : inv.field;
			const target = holder['x-reference'];
			// a wildcard or union target is left alone: "which of these collections is the pair with"
			// has no answer here, and pass 2 already speaks for those shapes.
			if (typeof target !== 'string' || target === '*') continue;
			const other = byName.get(target)?.schema?.properties?.[mirror];
			if (!other || typeof other !== 'object' || (target === name && mirror === field)) continue;
			const oHolder = (other.items && typeof other.items === 'object') ? other.items : other;
			const oInv = oHolder['x-inverse'];
			// MUTUAL iff each side's x-inverse names the other's FIELD and its x-reference names the
			// other's COLLECTION. Anything short of that is two relations that merely meet, and the
			// collision error in pass 2 is the right answer for those.
			if (!oInv || (typeof oInv === 'string' ? oInv : oInv.field) !== field || oHolder['x-reference'] !== name) continue;
			// WHO OWNS: the SCALAR side, because that is where the foreign key physically lives — which
			// resolves every pair a real workspace has been found to carry. The symmetric shapes have no
			// such answer, so they fall to a rule that at least cannot move under re-ordered discovery:
			// x-unique first (a 1:1 written twice), then the qualified field name.
			const here = `${name}.${field}`, there = `${target}.${mirror}`;
			let ownsHere, why;
			if ((prop.type === 'array') !== (other.type === 'array')) { ownsHere = prop.type !== 'array'; why = 'the scalar side is where the foreign key lives'; }
			else if ((holder['x-unique'] === true) !== (oHolder['x-unique'] === true)) { ownsHere = holder['x-unique'] === true; why = 'it declares x-unique'; }
			else { ownsHere = here < there; why = 'both sides are the same shape, so the name decides'; }
			const owns = ownsHere ? here : there, folded = ownsHere ? there : here;
			const ownsColl = ownsHere ? name : target, foldedColl = ownsHere ? target : name;
			console.warn(`⚠ relation ${owns} ⟷ ${folded}: declared on BOTH sides with x-inverse — that is ONE relation, not two. ${owns} owns it (${why}), so ${folded} is now GENERATED: delete that field from whichever descriptor of ${foldedColl} declares it (${srcsOf(foldedColl)}) and keep the x-inverse on ${owns} (${srcsOf(ownsColl)}). Its description is kept; every other keyword on it is DROPPED.`);
			if (ownsHere) foldMirrorSide(byName.get(target), target, mirror, other, holder, here);
			else foldMirrorSide(d, name, field, prop, oHolder, there);
		}
	}
	// ---- pass 2: every owner x-inverse stamps the mirror ------------------------------
	for (const [name, d] of byName) {
		for (const [field, prop] of Object.entries(d.schema?.properties ?? {})) {
			if (!prop || typeof prop !== 'object') continue;
			const holder = (prop.items && typeof prop.items === 'object') ? prop.items : prop;
			const inv = holder['x-inverse'];
			if (!inv) continue;
			const mirrorName = typeof inv === 'string' ? inv : inv.field;
			const raw = holder['x-reference'];
			if (raw === '*' || raw == null) fail(`collection "${name}": field "${field}" declares x-inverse on x-reference '*' — a wildcard has no target to stamp.`);
			if (holder['x-on-delete'] !== undefined && !['restrict', 'set-null'].includes(holder['x-on-delete'])) {
				fail(`collection "${name}": field "${field}" x-on-delete must be restrict or set-null.`);
			}
			if (holder['x-on-delete'] === 'set-null' && (d.schema.required ?? []).includes(field)) {
				fail(`collection "${name}": field "${field}" is required — x-on-delete: set-null would produce an invalid record. Use restrict, or drop required.`);
			}
			// THE SAME HOLE, one shape along: a LIST with a floor. `rm` clears set-null by removing the
			// one entry that named the deleted record, and takes the key with it when that was the last
			// — so `minItems: 1` is safe (absent and empty read alike to every reader) and anything
			// higher is not. Measured on `minItems: 2` with two values: `dt rm meetings/kickoff` printed
			// ✔ removed, and `dt check` then reported `must NOT have fewer than 2 items` on a record
			// nobody had touched. `rm` does not validate the owners it rewrites — deliberately, since
			// its job is to honour a policy the descriptor already declared — so the contradiction has
			// to be refused where the descriptor is read.
			if (holder['x-on-delete'] === 'set-null' && prop.type === 'array' && (prop.minItems ?? 0) > 1) {
				fail(`collection "${name}": field "${field}" declares minItems: ${prop.minItems} — x-on-delete: set-null removes ONE entry per deleted record, so it would leave a list shorter than its own minimum and no write would be validating it. Use restrict, or drop minItems.`);
			}
			// x-unique on a LIST is a keyword no component can honour, and all of them read it
			// differently: relationsOf calls the pair `m2m` while stampMirror generates the SCALAR
			// mirror x-unique implies, so `dt relations` prints m2m beside a scalar; check tests
			// uniqueness only for a scalar FK, so it never fires; and the store enforces it at write
			// time regardless. Three components disagreeing about one descriptor is a descriptor error.
			if (prop.type === 'array' && holder['x-unique'] === true) {
				fail(`collection "${name}": field "${field}" is a list, and x-unique means the foreign key is one-to-one — the two cannot both be true. Drop x-unique, or make the field a single reference.`);
			}
			holder['x-inverse'] = mirrorName; // canonical string form in the compiled output
			for (const target of Array.isArray(raw) ? raw : [raw]) {
				stampMirror(byName, ctx, name, field, prop, holder, mirrorName, target, typeof inv === 'object' ? inv.description : undefined);
			}
		}
	}
}

function stampMirror(byName, ctx, ownerName, field, prop, holder, mirrorName, target, description) {
	const t = byName.get(target);
	if (!t) return; // an unresolved peer — the ref contract already warned
	// cross-module gate, mirrored per spelling: the OWNING module stamps a field onto the target,
	// so it must hard-depend on the target's module (extends: uses the same gate). Same repo only.
	const ownerModule = ctx.moduleOf(ownerName), targetModule = ctx.moduleOf(target);
	if (ownerModule !== targetModule) {
		const deps = ctx.moduleDeps.get(ownerModule) ?? [];
		if (![...deps].includes(targetModule) && ownerModule !== ctx.wsModuleName) {
			fail(`collection "${ownerName}": x-inverse on "${field}" stamps a field onto ${target} (module ${targetModule}) — declare "${targetModule}" in dreamteamer.dependencies, or leave the link one-way.`);
		}
	}
	if ((byName.get(ownerName).storage?.repo ?? '.') !== (t.storage?.repo ?? '.')) {
		fail(`collection "${ownerName}": x-inverse on "${field}" crosses storage.repo — one commit cannot span two repos. Leave the link one-way.`);
	}
	// ---- can the target HOLD a mirror at all? -----------------------------------------
	// A mirror is a field the store writes onto the target record, so a target with nowhere to put a
	// field is not a link to degrade — it is a descriptor asking for something that cannot exist.
	// Both of these were found by pointing a relation at one and watching the store do damage, and
	// both are refused here rather than patched there: a guard in the store leaves the workspace
	// permanently `stale` with no way to fix it, because the mirror can never be written.
	if ((t.storage?.codec ?? 'md') === 'file') {
		fail(`collection "${ownerName}": x-inverse on "${field}" stamps a mirror onto ${target}, whose records ARE files (codec: file) — the bytes are the whole record, there is no frontmatter to hold a generated field. Leave the link one-way.`);
	}
	if (t.storage?.base === 'runtime') {
		fail(`collection "${ownerName}": x-inverse on "${field}" stamps a mirror onto ${target}, whose records are compiled sources — the store would write into .dreamteamer/, which the next compile overwrites. Leave the link one-way.`);
	}
	// The THIRD such shape, and the quietest: a `codec: md` record's BODY lives after the
	// frontmatter, and `serialize` carries it only where the descriptor declares an `x-body` field.
	// `dt schema add-collection` with no template declares none — so prose in such a record is
	// invisible to the parser, and a mirror write rebuilds the file from its parsed fields alone,
	// WITHOUT the body. That write lands on the far side of somebody else's `dt add`, in a collection
	// they never named, and `check` is silent either side of it. Refused here for the same reason as
	// the two above: a guard in the store would leave the workspace permanently `stale` instead,
	// because the mirror could never be written.
	if ((t.storage?.codec ?? 'md') === 'md' && !bodyKeys(t.schema).length) {
		// ⚠ THE REMEDY IS QUOTED, because for one minor it was UNREACHABLE. This said "declare an
		// x-body field" while `schema add-field` had no flag that marks one — so the only way to
		// follow the instruction was to hand-edit a descriptor the verb owns. `--body` exists now,
		// and a message that names a fix has to name the command that performs it.
		fail(`collection "${ownerName}": x-inverse on "${field}" stamps a mirror onto ${target}, whose descriptor declares no x-body — a record there cannot round-trip a body through a mirror write, so the store would silently erase any prose it holds. Declare one:\n  dreamteamer schema add-field ${target} --name notes --type markdown --body\n…or leave the link one-way.`);
	}
	const unique = holder['x-unique'] === true;
	const inverseOf = `${ownerName}.${field}`;
	// A mirror is readOnly, so `required` naming one describes a record nobody can write — the
	// engine forbids setting the field and validation forbids omitting it. Same shape as the
	// `x-on-delete: set-null` + required guard on the owning side, and it covers BOTH spellings:
	// spelling B's authored field is deleted in pass 1 and regenerated here under the same key, so
	// `required` still names it either way.
	if ((t.schema.required ?? []).includes(mirrorName)) {
		fail(`collection "${target}": field "${mirrorName}" is required, but ${inverseOf} generates it as a readOnly mirror — drop it from required, or drop the x-inverse on ${inverseOf}.`);
	}
	const generated = unique
		? { type: 'string', 'x-reference': ownerName, readOnly: true, 'x-inverse-of': inverseOf }
		// `uniqueItems` on the GENERATED array only — an authored reference array is the author's to
		// shape. The store writes a set here and expectedMirrors computes one, so a duplicate in a
		// mirror is never a value the engine produced: it arrived by hand, and saying "duplicate
		// items" is a truer report than the "stale" the relation pass would otherwise print.
		: { type: 'array', items: { type: 'string', 'x-reference': ownerName, 'x-inverse-of': inverseOf }, readOnly: true, uniqueItems: true };
	generated.description = description ?? `Generated from ${inverseOf} — set that field.`;
	const existing = t.schema.properties?.[mirrorName];
	if (existing) {
		// the legacy both-sides shape: an authored field that matches what we'd generate is a
		// warning for one minor; a real mismatch is an error.
		const e = (existing.items && typeof existing.items === 'object') ? existing.items : existing;
		// FIRST, distinguish a hand-authored field from ANOTHER RELATION'S MIRROR. Pass 1 deletes
		// every authored `x-inverse-of` field, so anything still carrying one at stamp time was
		// generated by an earlier stampMirror call. Two relations stamping one name is not a
		// duplicate declaration of one relation — it is two relations sharing one slot, and because
		// both mirrors have the identical shape (an array of refs to the same owner) the sameShape
		// guard below waves it through. The result is unfixable rather than merely wrong: check
		// computes an expectation per relation, so the target gets two contradictory `stale`
		// violations that no value satisfies and no rebuild can repair. Refuse it at compile.
		const generatedBy = e['x-inverse-of'];
		if (generatedBy && generatedBy !== inverseOf) {
			fail(`collection "${target}": both ${generatedBy} and ${inverseOf} generate a mirror named "${mirrorName}" — one field cannot hold two relations. Give one of them a different x-inverse name.`);
		}
		// ITEMS TYPE IS PART OF THE SHAPE. Comparing only the outer `type` let an authored
		// `array of object` pass as "the same shape" as an array of reference strings, and the
		// generated mirror then silently replaced a field of a genuinely different kind.
		const sameShape = (existing.type === generated.type)
			&& ((e['x-reference'] ?? null) === ownerName)
			&& (generated.type !== 'array' || (existing.items?.type ?? null) === generated.items.type);
		if (!sameShape) fail(`collection "${target}": field "${mirrorName}" collides with the mirror generated from ${inverseOf} — rename one.`);
		// EXACTLY TWO authored keywords survive, and the warning says so rather than offering a fix
		// that cannot be performed: `x-inverse`'s object form carries `field` and `description` only,
		// so "move its extras into x-inverse" was advice with nowhere to move them to.
		//
		// It says DECLARES, not "generates": what the author has to act on is that the same relation
		// is stated twice — by hand here, and by x-inverse there — and the generation is only the
		// consequence. "generates it" described the engine's behaviour and left the duplicate
		// declaration — the actual defect, and the only thing they can delete — unnamed.
		console.warn(`⚠ collection ${target}: field "${mirrorName}" is hand-authored but ${inverseOf} declares it — delete the authored field. Its description and x-title-template are kept; every other keyword on it is DROPPED.`);
		generated.description = existing.description ?? generated.description;
		// on the node it was authored on — post-hoist that is the holder, `items` for an array
		const gHolder = (generated.items && typeof generated.items === 'object') ? generated.items : generated;
		if (e['x-title-template'] !== undefined) gHolder['x-title-template'] = e['x-title-template'];
	}
	t.schema.properties = { ...t.schema.properties, [mirrorName]: generated };
}

export const KINDS = ['collections', 'skills', 'agents', 'commands', 'command-bindings', 'ui-views', 'collection-templates'];
const FOLDER_KINDS = new Set(['skills']); // folder-shape entities: copy the whole record folder
// DERIVED_KINDS (projected, not staged) lives in runtime.js — the boundary both halves read. Not in
// KINDS on purpose: a module folder named `modules/` would be nonsense, and `isSystem` below keys
// off KINDS to decide `storage.base`, so a `modules` collection landing on `base: workspace` would
// point the store at the SOURCE directory and read every module folder as a record.

/**
 * A module's source folder for one kind. The layout is FLAT — `<module>/skills`, beside `data/` —
 * because KINDS is already the allowlist and the extra `system/` level named nothing the engine
 * reads. `<module>/system/<kind>` is still accepted so a module can be moved independently of the
 * engine that reads it (they are separate repos on separate pins).
 *
 * Returns the FLAT path when neither exists, so a caller that creates the folder creates it in the
 * layout we want. `bothLayouts` reports the split case, which compile warns about — a module with
 * half its sources in each place compiles the flat half and silently drops the rest otherwise.
 */
export function kindDir(root, kind) {
	const flat = path.join(root, kind);
	if (fs.existsSync(flat)) return flat;
	const nested = path.join(root, 'system', kind);
	return fs.existsSync(nested) ? nested : flat;
}

function bothLayouts(root, kind) {
	return fs.existsSync(path.join(root, kind)) && fs.existsSync(path.join(root, 'system', kind));
}

/**
 * Folders a module may hold that are not sources. With kinds at the module root, "not a kind" can no
 * longer mean "ignore it" — that is precisely how a kind the engine stopped knowing (`workflows`,
 * removed 2026-07-31) sat in a module for two days while compile reported ✔ and a README described a
 * pipeline nothing read (decision 156).
 *
 * So the root is ENUMERATED and an unrecognised folder is an ERROR. This list covers what a package
 * generically contains; anything else the module declares in its own package.json
 * (`dreamteamer.ignore`). That is real per-module variance — `services` has `dashboard/`, `agentlog`
 * has `data/` — not a layout knob every module would set identically.
 */
const NON_SOURCE_DIRS = new Set([
	'node_modules', 'data', 'state', 'media', 'bin', 'src', 'lib', 'scripts',
	'ui', 'studio', // the module's UI bundle — 'studio' is the pre-archive name, kept as a fallback
	'docs', 'dist', 'build', 'test', 'tests', 'coverage', 'system', // 'system': the pre-flatten layout
]);

/** Unrecognised source-root folders in a module, or [] for the workspace root (a vault legitimately
 *  holds arbitrary directories — this gate is about PACKAGES, whose folders all mean something). */
function strayKindDirs(source, wsRoot, declaredIgnore) {
	if (path.resolve(source.root) === path.resolve(wsRoot)) return [];
	const allow = new Set([...KINDS, ...NON_SOURCE_DIRS, ...declaredIgnore]);
	return fs.readdirSync(source.root, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !allow.has(e.name))
		.map((e) => e.name)
		.sort();
}

const sha256 = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');

// channel -> the directory the operator knows it by (used in shadow warnings)
export const CHANNEL_LABEL = { inline: 'modules', git: 'git_modules', npm: 'node_modules' };

// module discovery, three channels in precedence order: inline modules/* >
// git_modules/* > npm deps (declared in package.json, NOT a node_modules scan).
// same NAME in two channels = the same module delivered twice — the more local
// copy wins (npm-link semantics); shadows are returned for warning/status, never
// compiled. different-name identity collisions stay hard errors downstream.
export function discoverModules(root, pkg) {
	const byName = new Map(); // name -> {name, root, channel}
	const shadows = []; // {name, winner, loser} — channels
	const tryAdd = (name, srcRoot, channel) => {
		const existing = byName.get(name);
		if (existing) { shadows.push({ name, winner: existing.channel, loser: channel }); return; }
		byName.set(name, { name, root: srcRoot, channel });
	};
	const scanDir = (dir, channel) => {
		if (!fs.existsSync(dir)) return;
		for (const name of fs.readdirSync(dir).sort()) {
			const srcRoot = path.join(dir, name);
			const pkgPath = path.join(srcRoot, 'package.json');
			if (!fs.existsSync(pkgPath)) continue;
			try {
				const mpkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
				if ('dreamteamer' in mpkg) tryAdd(mpkg.name ?? name, srcRoot, channel);
			} catch { /* unparseable package.json — skip */ }
		}
	};
	scanDir(path.join(root, 'modules'), 'inline');
	scanDir(path.join(root, 'git_modules'), 'git');
	for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()) {
		const srcRoot = path.join(root, 'node_modules', dep);
		try {
			const mpkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8'));
			if ('dreamteamer' in mpkg) tryAdd(mpkg.name ?? dep, srcRoot, 'npm');
		} catch { /* dep not installed or no package.json — skip */ }
	}
	return { modules: [...byName.values()], shadows };
}

// ---- module-owned data ----------------------------------------------------------
// A module with `owns-data: true` keeps its records BESIDE ITSELF rather than in the
// workspace's data/. The descriptor still says `data/<collection>`; compile is what turns
// that into a path, so the module never names its host.

/** modules that own their data, by module name → {root, channel}. Validates the flag and the
 *  channel: records that could never be committed are a compile ERROR, not a silent zero. */
function dataOwningModules(sources, fail, rel) {
	const owners = new Map();
	for (const s of sources) {
		let mpkg;
		try { mpkg = JSON.parse(fs.readFileSync(path.join(s.root, 'package.json'), 'utf8')); } catch { continue; }
		const flag = mpkg.dreamteamer?.['owns-data'];
		if (flag === undefined || flag === false) continue;
		if (flag !== true) fail(`module "${s.name}": "owns-data" must be true or false (got ${JSON.stringify(flag)})`);
		// Decided from the CHANNEL, never by asking git — compile shells out to git nowhere and
		// must keep working in a freshly-`init`ed directory that is not a repo yet.
		if (s.channel === 'npm') {
			fail(`module "${s.name}" sets owns-data, but it is installed under node_modules/ — that path is never committed, so its records could not be saved. Vendor it into modules/ or install it as a git module.`);
		}
		if (s.channel === 'git' && !fs.existsSync(path.join(s.root, '.git'))) {
			fail(`module "${s.name}" sets owns-data, but ${rel(s.root)} is not a git clone — git_modules/ is gitignored by the workspace, so its records could never be committed.`);
		}
		owners.set(s.name, { root: s.root, channel: s.channel });
	}
	return owners;
}

/** The git repo that will hold a module's records: nearest `.git` at or above the module root,
 *  as a workspace-relative path (`.` = the workspace itself). `.git` may be a FILE — worktrees
 *  and submodules write a pointer file rather than a directory — so existsSync, not isDirectory. */
function repoRootOf(moduleRoot, wsRoot) {
	const stop = path.resolve(wsRoot);
	let dir = path.resolve(moduleRoot);
	while (dir.startsWith(stop)) {
		if (fs.existsSync(path.join(dir, '.git'))) return path.relative(stop, dir) || '.';
		if (dir === stop) break;
		dir = path.dirname(dir);
	}
	return '.';
}

export function shadowWarning({ name, winner, loser }) {
	return `⚠ module ${name}: ${CHANNEL_LABEL[winner]} copy shadows ${CHANNEL_LABEL[loser]} copy`;
}

export function compile({ root, pkg }) {
	const RUNTIME = runtimeDir(root);
	const config = pkg.dreamteamer ?? {};
	const harnesses = config.harnesses ?? ['claude-code'];
	const rel = (p) => path.relative(root, p);

	// ---- discover sources: channel modules then the workspace's own -----------------
	const { modules: discovered, shadows } = discoverModules(root, pkg);
	for (const s of shadows) console.warn(shadowWarning(s));
	const sources = [...discovered];
	// workspace-owned sources: either at the root (classic layout) or in the designated
	// workspace module under modules/ (config `workspace-module` — "the workspace is itself a
	// module", made literal). when the key is set the root is NOT read, so the two layouts can
	// never fork — and a stray source folder up there is a loud error rather than a silent drop.
	if (!config['workspace-module']) {
		sources.push({ name: pkg.name, root, channel: 'inline' });
	} else {
		const strays = [];
		if (fs.existsSync(path.join(root, 'system')) && [...walk(path.join(root, 'system'))].length) strays.push('system/');
		for (const kind of KINDS) {
			const dir = path.join(root, kind);
			if (fs.existsSync(dir) && [...walk(dir)].length) strays.push(`${kind}/`);
		}
		if (strays.length) {
			fail(`the workspace root contains sources (${strays.join(', ')}) but workspace-module="${config['workspace-module']}" is set — they would be silently ignored.\n  move them into modules/${config['workspace-module']}/ (decision 22).`);
		}
	}

	// ---- module package pass: engine ranges + env declarations (M4) ---------------
	// both are WARNINGS, never errors — a version skew or missing secret must not
	// brick a solo operator's workspace at compile time.
	const engineVer = engineVersion();
	const declaredEnv = new Map(); // env key -> [module names]
	const moduleIgnores = new Map(); // module name -> non-source folders it declares (strayKindDirs)
	const moduleDeps = new Map();  // module name -> [module names]      — HARD, must be acyclic
	const modulePeers = new Map(); // module name -> [collection names]  — SOFT, cannot cycle
	for (const source of sources) {
		let mpkg;
		try { mpkg = JSON.parse(fs.readFileSync(path.join(source.root, 'package.json'), 'utf8')); } catch { continue; }
		const ignore = mpkg.dreamteamer?.ignore;
		if (ignore !== undefined) {
			if (!Array.isArray(ignore)) fail(`module "${source.name}": "ignore" must be a list of folder names (got ${JSON.stringify(ignore)})`);
			moduleIgnores.set(source.name, ignore.map(String));
		}
		// npm's TERMINOLOGY, deliberately not npm's namespace: these live under `dreamteamer` so
		// npm's own resolver never tries to fetch an inline or git-channel module.
		for (const [key, sink] of [['dependencies', moduleDeps], ['peerDependencies', modulePeers]]) {
			const decl = mpkg.dreamteamer?.[key];
			if (decl === undefined) continue;
			if (!Array.isArray(decl) || decl.some((v) => typeof v !== 'string')) {
				fail(`module "${source.name}": dreamteamer.${key} must be a list of ${key === 'dependencies' ? 'module names' : 'collection names'} (got ${JSON.stringify(decl)})`);
			}
			sink.set(source.name, decl);
		}
		const range = mpkg.dreamteamer?.engine;
		if (range) {
			const ok = satisfies(engineVer, range);
			if (ok === false) console.warn(`⚠ module ${source.name} declares engine "${range}" — running engine is ${engineVer} (out of range; compile continues)`);
			else if (ok === null) console.warn(`⚠ module ${source.name}: engine range "${range}" not understood by the built-in checker (see src/semver.js) — not verified`);
		}
		for (const k of mpkg.dreamteamer?.env ?? []) {
			if (!declaredEnv.has(k)) declaredEnv.set(k, []);
			declaredEnv.get(k).push(source.name);
		}
	}
	// `dreamteamer.vars` is the WORKSPACE's own declaration (root package.json, not a module's): the
	// keys a `${env:NAME}` template is allowed to name. Same missing-key question as
	// `dreamteamer.env`, one .env parse, two warnings — a module needs its key to RUN, a var is
	// needed the moment someone calls `dt resolve`, and only the workspace can declare one.
	if (config.vars !== undefined && (!Array.isArray(config.vars) || config.vars.some((v) => typeof v !== 'string'))) {
		fail(`dreamteamer.vars must be a list of env key names (got ${JSON.stringify(config.vars)})`);
	}
	const declaredVars = config.vars ?? [];
	if (declaredEnv.size || declaredVars.length) {
		// .env is parsed for KEY names ONLY — values never reach any output or the manifest
		const envPath = path.join(root, '.env');
		if (!fs.existsSync(envPath)) {
			if (declaredEnv.size) console.warn(`⚠ no .env — modules declare env keys: ${[...declaredEnv.keys()].join(', ')} (see .env.example)`);
			if (declaredVars.length) console.warn(`⚠ no .env — dreamteamer.vars declares ${declaredVars.join(', ')}, so no \${env:…} template can render here (see .env.example)`);
		} else {
			// ⚠ THE ONE PARSER, not a key regex of our own. This used to hand-roll
			// `/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/`, which accepted two lines
			// `parseEnvValues` deliberately drops (`KEY =value`, and an indented key) and scanned a
			// quoted value's continuation lines for keys. Either disagreement produces the worst
			// pairing there is: compile says nothing and then `dt resolve` answers "no value in
			// .env" about a line the operator is looking straight at. Values are read here and
			// never printed — the warnings below name keys only.
			// A key present with an EMPTY (or whitespace-only) value is treated as absent, same as
			// resolve's renderTemplate — `FILES_FOLDER=` must warn here exactly as `FILES_FOLDER`
			// missing entirely would, or compile says nothing and resolve fails on the same line.
			const parsedEnv = parseEnvValues(fs.readFileSync(envPath, 'utf8'));
			const present = new Set([...parsedEnv].filter(([, v]) => v.trim() !== '').map(([k]) => k));
			for (const [k, mods] of declaredEnv) {
				if (present.has(k)) continue;
				for (const mod of mods) console.warn(`⚠ module ${mod} declares env key ${k} — missing from .env (see .env.example)`);
			}
			for (const k of declaredVars) {
				if (present.has(k)) continue;
				console.warn(`⚠ dreamteamer.vars declares ${k} — missing from .env, so \${env:${k}} cannot render on this machine`);
			}
		}
	}

	// ---- the module dependency graph -------------------------------------------------
	// `dependencies` names MODULES and must be acyclic. `peerDependencies` names COLLECTIONS and
	// therefore cannot cycle at all — which is the whole reason it exists: two modules that each
	// reference a concept the other owns (crm needs `products`, rnd needs `contacts`) would be an
	// unbreakable ring under module-named deps, and are two independent peer declarations here.
	const moduleNames = new Set(sources.map((s) => s.name));
	for (const [mod, deps] of moduleDeps) {
		for (const dep of deps) {
			if (dep === mod) fail(`module "${mod}" declares itself as a dependency`);
			if (!moduleNames.has(dep)) {
				fail(`module "${mod}" depends on "${dep}", which is not installed — modules present: ${[...moduleNames].sort().join(', ')}`);
			}
		}
	}
	// DFS with an explicit path so the error can print the ring rather than just naming one module
	{
		const state = new Map(); // name -> 'open' | 'done'
		const visit = (mod, trail) => {
			if (state.get(mod) === 'done') return;
			if (state.get(mod) === 'open') {
				const ring = [...trail.slice(trail.indexOf(mod)), mod];
				fail(`cyclic module dependencies: ${ring.join(' → ')}\n  a reference to a CONCEPT another module owns belongs in dreamteamer.peerDependencies (a collection name), which cannot cycle.`);
			}
			state.set(mod, 'open');
			for (const dep of moduleDeps.get(mod) ?? []) visit(dep, [...trail, mod]);
			state.set(mod, 'done');
		};
		for (const mod of moduleDeps.keys()) visit(mod, []);
	}

	const dataOwners = dataOwningModules(sources, fail, rel);

	const disabled = new Set(config.disable ?? []);
	const disabledHits = new Set();

	/** entries: runtime-relative path -> { sources: [workspace-relative], bytes } */
	const entries = new Map();
	const counts = {};
	/** collection descriptors collected per name for extends-merging: name -> [{src, doc, moduleName}] */
	const descriptorGroups = new Map();

	function addEntry(runtimePath, srcPath) {
		if (entries.has(runtimePath)) {
			const [, kind, entity] = /^([^/]+)\/([^/]+)/.exec(runtimePath) ?? [];
			const entityId = (entity ?? '').replace(/\.[^.]+\.(yaml|md|json)$/, '');
			const prev = entries.get(runtimePath).sources[0].path;
			fail(`name collision on ${kind?.replace(/s$/, '') ?? 'entity'} "${entityId}"
    - ${prev}
    - ${rel(srcPath)}
  identity entities are never merged or shadowed (schemas may use 'extends').
  either rename yours, or disable one: add "<module>/${entityId}" to dreamteamer.disable in package.json.`);
		}
		const bytes = fs.readFileSync(srcPath);
		entries.set(runtimePath, { sources: [{ path: rel(srcPath), hash: sha256(bytes) }], bytes });
	}

	/** module names that actually put something into the compiled runtime — see the warning below */
	const contributed = new Set();

	for (const source of sources) {
		// an unrecognised folder at a module root is a typo'd kind or a kind the engine dropped —
		// both of which used to compile ✔ and contribute nothing (see NON_SOURCE_DIRS)
		const strays = strayKindDirs(source, root, moduleIgnores.get(source.name) ?? []);
		if (strays.length) {
			fail(`module "${source.name}" (${rel(source.root)}) has folder(s) that are not a known kind: ${strays.join(', ')}
  known kinds: ${KINDS.join(', ')}
  if these are not sources, declare them: "dreamteamer": { "ignore": [${strays.map((s) => `"${s}"`).join(', ')}] } in ${rel(path.join(source.root, 'package.json'))}`);
		}
		for (const kind of KINDS) {
			// a half-moved module compiles its flat half and drops the rest — say so rather than
			// reporting ✔ over a silent partial read (the decision-156 failure shape)
			if (bothLayouts(source.root, kind)) {
				console.warn(`⚠ module ${source.name}: both ${kind}/ and system/${kind}/ exist — the flat copy wins and system/${kind}/ is NOT compiled. finish the move.`);
			}
			const srcDir = kindDir(source.root, kind);
			if (!fs.existsSync(srcDir)) continue;
			counts[kind] ??= 0;
			// `collections/` is enumerated RECURSIVELY, so a namespaced descriptor can be authored at
			// `collections/health/doctors.collection.yaml` — mirroring where it lands in the runtime and
			// letting a workspace group its descriptors the same way its data is grouped.
			//
			// ⚠ This is load-bearing, not cosmetic. `schema-ops` derives a descriptor's source path from
			// its name, so `add-field` on `health/doctors` writes the nested path; with a flat readdir
			// that file was written, silently skipped, and the verb reported ✔ while changing nothing —
			// the decision-156 shape again. Every other kind stays flat: their ids are single segments.
			const names = kind === 'collections'
				? [...walk(srcDir)].map((f) => path.relative(srcDir, f).split(path.sep).join('/'))
				: fs.readdirSync(srcDir).sort();
			for (const name of names) {
				if (name.startsWith('.')) continue;
				const entityId = name.replace(/\.[^.]+\.(yaml|md|json)$/, '');
				if (disabled.has(`${source.name}/${entityId}`)) { disabledHits.add(`${source.name}/${entityId}`); continue; }
				const srcPath = path.join(srcDir, name);
				const isDir = fs.statSync(srcPath).isDirectory();
				if (kind === 'collections' && !isDir) {
					// descriptors merge via 'extends' — collect per collection name
					const bytes = fs.readFileSync(srcPath);
					const doc = load(bytes.toString('utf8'));
					// `codec: file` records are opaque bytes: there are no fields, so there is no schema to
					// require and none to honour. Every other codec parses text into fields and must declare
					// what they are.
					const opaque = doc.storage?.codec === 'file';
					if (!doc.name || (!doc.schema && !doc.extends && !opaque)) fail(`${rel(srcPath)}: descriptor needs 'name' and 'schema' (or 'extends')`);
					if (opaque && (doc.storage.shape ?? 'file') === 'folder') fail(`${rel(srcPath)}: collection "${doc.name}" is \`codec: file\` — that is one file per record, not a folder; drop \`shape: folder\``);
					if (opaque && Object.keys(doc.schema?.properties ?? {}).length) console.warn(`⚠ collection ${doc.name}: \`schema\` is ignored under \`codec: file\` — an opaque record's fields are derived (ext, bytes)`);
					if (!descriptorGroups.has(doc.name)) descriptorGroups.set(doc.name, []);
					descriptorGroups.get(doc.name).push({ src: { path: rel(srcPath), hash: sha256(bytes) }, doc, moduleName: source.name });
					contributed.add(source.name);
				} else if (FOLDER_KINDS.has(kind) && isDir) {
					for (const file of walk(srcPath)) {
						addEntry(path.join(kind, name, path.relative(srcPath, file)), file);
						contributed.add(source.name);
					}
					counts[kind]++;
				} else if (!isDir) {
					addEntry(path.join(kind, name), srcPath);
					contributed.add(source.name);
					counts[kind]++;
				} else {
					// nested dirs for file-shape kinds (e.g. date-partitioned) — recurse
					for (const file of walk(srcPath)) {
						addEntry(path.join(kind, path.relative(srcDir, file)), file);
						contributed.add(source.name);
						counts[kind]++;
					}
				}
			}
		}
	}

	// ---- stage module UI bundles ---------------------------------------------------
	// modules ship a PRE-BUILT app.js that registers components/layouts against the surface's
	// registry (design "the UI": components are module code, never records). staged under
	// .dreamteamer/ui/<module>/app.js; the VS Code extension reads it off disk (decision 48) and
	// the legacy server served it at /ui. `dist/app.js` (a built bundle) wins over `app.js`
	// (plain-JS, host-provided Vue).
	//
	// `ui/` is the name — it matches where the bundle STAGES and what it is. `studio/` is the
	// original name and stays a fallback: the studio it referred to is archived (decisions 51, 93),
	// so the folder was named after a surface that no longer exists. Both are in NON_SOURCE_DIRS,
	// so neither trips the unknown-folder gate (decision 179).
	const uiModules = [];
	const uiOwners = new Map(); // shortName -> module name, for a readable collision error
	for (const source of sources) {
		const cand = ['ui/dist/app.js', 'ui/app.js', 'studio/dist/app.js', 'studio/app.js']
			.map((p) => path.join(source.root, p))
			.find((p) => fs.existsSync(p));
		if (!cand) continue;
		// short name = full package name, url-safe: "@" stripped, "/" → "--"
		// (@a/crm and @b/crm used to both stage ui/crm — audit finding 4). unscoped
		// names are unchanged, so existing /ui/<name>/app.js paths survive.
		const shortName = source.name.replace(/^@/, '').replace(/\//g, '--');
		const prevOwner = uiOwners.get(shortName);
		if (prevOwner) fail(`ui bundle collision: modules "${prevOwner}" and "${source.name}" both stage ui/${shortName}/app.js — rename one package.`);
		uiOwners.set(shortName, source.name);
		addEntry(path.join('ui', shortName, 'app.js'), cand);
		uiModules.push(shortName);
		// A UI bundle IS a contribution. Counting it here is what keeps the warning below honest —
		// a module whose whole purpose is a layout used to be told it "contributed no recognised
		// sources" while its layout was rendering in the app.
		contributed.add(source.name);
	}

	// A module that ships only folders the engine does not recognise compiles ✔ and contributes
	// NOTHING. Warn; do not fail, since a module that is temporarily source-free is the
	// operator's business, not the compiler's. Runs AFTER UI staging so a UI-only module counts.
	for (const source of sources) {
		if (contributed.has(source.name)) continue;
		console.warn(`⚠ module "${source.name}" (${rel(source.root)}) contributed no recognised sources — its folder names must match a known kind (${KINDS.join(', ')}) or it must ship a UI bundle at ui/app.js`);
	}

	// ---- collection-templates, for `templates:` merging ----------------------------
	// A template is a live, shared field set — not the copy-once scaffold `collections add
	// --template` used to stamp out. A descriptor declaring `templates: [collection-templates/x]`
	// gets x's `template:` merged in BEFORE base/extender discrimination, with precedence
	// template < base < overlay. (The key is `templates:`, not `extends:` — `extends:` already
	// means "this descriptor overlays another module's collection of the same name".)
	const templateDocs = new Map();     // id -> { template, src }
	for (const [rt, entry] of entries) {
		const m = /^collection-templates\/(.+)\.collection-template\.yaml$/.exec(rt);
		if (!m) continue;
		const doc = load(entry.bytes.toString('utf8'));
		templateDocs.set(m[1], { template: doc.template ?? {}, src: entry.sources[0] });
	}

	// ---- namespaces: the declared list, validated against what actually compiled ----------
	// Declared in the WORKSPACE package.json only, never per-module. A module that could declare a
	// namespace could rename where another module's records live, and the whole point of a namespace
	// is that the workspace decides how its own data is partitioned. `namespaces` is also config
	// rather than records for the same bootstrap reason `git-modules` is (docs/repos-and-modules.md):
	// a reference has to be parseable before anything has been compiled.
	const namespaces = normalizeNamespaces(config.namespaces);
	const collectionNames = [...descriptorGroups.keys()];
	for (const p of namespaceProblems(namespaces, collectionNames)) fail(p);
	// The silent failure this whole feature had to fix: a slash in a collection name used to compile
	// clean, land at `.dreamteamer/collections/<ns>/<name>.collection.yaml`, and then vanish — the
	// descriptor loader read one directory level, so the collection was simply absent from the
	// runtime while compile reported ✔ (the same shape as decision 156).
	for (const p of unqualifiedProblems(collectionNames, namespaces)) fail(p);

	// ---- who owns which collection, and which module IS the workspace ----------------
	// Needed before the resolution loop so each descriptor can be validated against the graph as it
	// is merged. The owner is the group member that does NOT declare `extends`; a group with two of
	// those is a name collision, and the loop below raises it properly — this pass only maps.
	// A module's record id: the npm scope stripped, so `@dreamteamer/crm` reads as `crm` — which is
	// what every message in this engine already calls it.
	const moduleId = (n) => slug(String(n).replace(/^@[^/]+\//, ''));
	const collOwner = new Map(); // collection name -> owning module name
	const moduleColls = new Map(); // module name -> Set(collection names it contributed to)
	for (const [name, group] of descriptorGroups) {
		const base = group.find((g) => !g.doc.extends);
		if (base) collOwner.set(name, base.moduleName);
	}
	// The engine's own nine collections are an implicit dependency of every module: the entity kinds
	// the compiler materializes, plus `repos` (because `repos ensure` clones them). Requiring every
	// module to declare a dependency on the host it cannot run without would be ceremony, not
	// verification. ⚠ `users` was in this set until 0.8.0 — a module still declaring
	// `x-reference: users` now FAILS here, which is the intended loud outcome rather than a ref
	// pointing at a collection nothing provides.
	const CORE_COLLECTIONS = new Set([...KINDS, ...DERIVED_KINDS, 'repos']);
	const wsDir = config['workspace-module'];
	const wsModuleName = wsDir
		? sources.find((s) => rel(s.root) === path.join('modules', wsDir))?.name
		: pkg.name;

	// ---- resolve descriptor groups (templates + extends merge) ---------------------
	counts.collections = 0;
	let mergedCount = 0;
	let templatedCount = 0;
	const storageEntries = []; // {name, path, base} per collection — checked for overlap after the loop
	// Merged descriptors are held, NOT dumped, until every one of them exists: a relation spans two
	// collections, and the second is not merged yet when the first is reached. So this loop resolves
	// and validates each descriptor on its own, `materializeRelations` runs over the whole set, and
	// only the loop after that derives labels and writes bytes.
	const mergedGroups = new Map(); // collection name -> {merged, sources}
	for (const [name, group] of descriptorGroups) {
		// a template's bytes feed the compiled descriptor, so it MUST be one of that descriptor's
		// declared sources — otherwise editing the template leaves every consumer silently stale
		// and `warnIfStale` has nothing to compare against.
		const templateSources = [];
		for (const g of group) {
			const decl = g.doc.templates;
			if (decl === undefined) continue;
			if (!Array.isArray(decl)) fail(`${g.src.path}: 'templates' must be a list of collection-templates/<id> refs`);
			for (const ref of decl) {
				const id = String(ref).replace(/^collection-templates\//, '');
				const t = templateDocs.get(id);
				if (!t) fail(`${g.src.path}: templates references "${ref}" — no such collection-template (have: ${[...templateDocs.keys()].join(', ') || 'none'})`);
				g.doc = applyTemplate(g.doc, t.template);
				templateSources.push(t.src);
				templatedCount++;
			}
			delete g.doc.templates;
		}

		const bases = group.filter((g) => !g.doc.extends);
		const extenders = group.filter((g) => g.doc.extends);
		if (bases.length === 0) fail(`collection "${name}": every descriptor declares 'extends' — no base found (${group.map((g) => g.src.path).join(', ')})`);
		if (bases.length > 1) fail(`name collision on collection "${name}"\n${bases.map((b) => `    - ${b.src.path}`).join('\n')}\n  same-name descriptors must declare 'extends: <module>/<collection>'.`);
		const base = bases[0];
		let merged = structuredClone(base.doc);
		for (const ext of extenders) {
			const expected = `${base.moduleName}/${name}`;
			if (ext.doc.extends !== expected) {
				fail(`${ext.src.path}: extends "${ext.doc.extends}" does not name the base "${expected}"`);
			}
			// `extends` is the hardest dependency there is — the extender does not compile at all
			// without the base (see the "no base found" failure above), so it must say so.
			if (ext.moduleName !== base.moduleName && !(moduleDeps.get(ext.moduleName) ?? []).includes(base.moduleName)) {
				fail(`${ext.src.path}: extends "${expected}" but module "${ext.moduleName}" does not declare "${base.moduleName}" in dreamteamer.dependencies — an overlay cannot compile without its base.`);
			}
			merged = mergeDescriptor(merged, ext.doc);
		}
		delete merged.extends;
		// ---- resolved storage: the path, the owning repo, and which root it hangs off ---
		// The three facts the record layer needs stated as DATA, so it never has to re-derive
		// them from the shape of a path (see runtime.js). `storage.path` stays root-relative;
		// `storage.repo` is read by the git layer alone; `storage.base` says WHICH root — and
		// this is the only place that decides it.
		//
		// A runtime-based collection's storage path IS a kind folder (`skills`), so an exact KINDS
		// match is the test. It used to be a `system/` prefix check, which the flatten silently
		// inverted: every one of the seven would have compiled as `base: workspace`, resolved under
		// the workspace root, read as zero records, and become writable through the store.
		merged.storage ??= {};
		const owned = dataOwners.get(storageOwnerOf(group, base));
		// A namespaced collection's folder IS its namespace, nested: `health/doctors` →
		// `data/health/doctors`. Derived rather than required so a descriptor never has to repeat its
		// own name in a path, and so moving a collection between namespaces is a one-line edit.
		// An authored `storage.path` still wins — registering an existing folder is a first-class case
		// (skills/using-dreamteamer/references/collections.md).
		merged.storage.path ??= defaultStoragePath(name, namespaces, config['data-path'] ?? 'data');
		// The middle segment of every record filename, `<id>.<suffix>.<ext>`. DERIVED here, exactly as
		// `path` is above, so the runtime always carries an explicit one.
		//
		// ⚠ Absent, it was interpolated raw and every record landed as `<id>.undefined.md` — silent at
		// compile, at `add` and at `check`, because `idFromRecordPath` reads the same undefined back
		// and the round trip agrees with itself. On a `codec: file` collection it is not even silent
		// for long: the next verb dies inside that function on `undefined.replace`.
		//
		// The rule is the singular of the BARE name (`health/doctors` records are `<id>.doctor.md`,
		// not `<id>.health/doctor.md`) — the same rule `collections add` writes into a new descriptor,
		// and the one `rename-collection` already ASSUMES when it tests `oldSuffix === singular(oldBase)`
		// to decide whether a suffix may be re-derived. Deriving here makes that assumption true rather
		// than coincidental. Kinder than refusing, and no existing workspace changes: a descriptor that
		// authors a suffix keeps it, and one that does not was writing `.undefined.` files.
		merged.storage.suffix ??= singular(baseNameOf(name, namespaces));
		const storagePath = String(merged.storage.path ?? '');
		const systemKinds = [...KINDS, ...DERIVED_KINDS];
		const isSystem = systemKinds.includes(storagePath) || systemKinds.includes(storagePath.replace(/^system\//, ''));
		merged.storage.base = isSystem ? 'runtime' : 'workspace';
		if (owned && !isSystem) {
			const modRel = rel(owned.root);
			merged.storage.path = modRel ? `${modRel}/${merged.storage.path}` : merged.storage.path;
			merged.storage.repo = repoRootOf(owned.root, root);
		} else {
			merged.storage.repo = '.';
		}
		storageEntries.push({ name, path: merged.storage.path, base: merged.storage.base });
		// An opaque record has no AUTHORED schema, but it does have fields — derived ones. Stating them
		// here rather than special-casing every reader is what keeps `codec: file` a codec instead of a
		// feature: ajv, the field list, `dt values`, the form and the diagram all carry on unchanged,
		// and what they read is true. Any authored schema was warned about and is replaced.
		if ((merged.storage.codec ?? 'md') === 'file') {
			merged.schema = {
				type: 'object',
				properties: {
					ext: { type: 'string', description: "The file's extension, lowercase and without the dot. Derived from the file — never written." },
					bytes: { type: 'integer', description: "The file's size in bytes. Derived from the file — never written." },
				},
			};
		}
		for (const [at, tpl, target] of staleDisplayKeywords(merged.schema)) {
			const fix = target
				? `either DELETE it (a reference to "${target}" now inherits that collection's \`title_template\`) or rename it to \`x-title-template\` if this field really needs its own`
				: 'rename it to `x-title-template`';
			fail(`collection "${name}": field "${at}" uses \`x-display: ${tpl}\` — that keyword was renamed; ${fix}. (${group.map((g) => g.src.path).join(', ')})`);
		}
		// the merged schema must itself be a compilable JSON Schema — a malformed property
		// (e.g. a string where an object belongs) used to pass compile and detonate at the
		// first record validation. caught HERE so the schema-ops dry-run gate is airtight.
		try {
			descriptorAjv().compile(structuredClone(merged.schema));
		} catch (e) {
			fail(`collection "${name}": schema is not a valid JSON Schema — ${e.message} (${group.map((g) => g.src.path).join(', ')})`);
		}
		// Same reasoning one line up, for the OTHER regex a descriptor carries. `patternRe` throws on a
		// malformed pattern, and it is called from `store.add` and from `check` — so without this gate a
		// typo'd `id.pattern` surfaces as a raw "Invalid regular expression" from inside a write instead
		// of as a compile error naming the descriptor.
		if (merged.id?.pattern !== undefined) {
			if (typeof merged.id.pattern !== 'string') fail(`collection "${name}": id.pattern must be a string (got ${JSON.stringify(merged.id.pattern)})`);
			try { patternRe(merged.id.pattern); } catch (e) {
				fail(`collection "${name}": id.pattern is not a valid regular expression — ${e.message} (${group.map((g) => g.src.path).join(', ')})`);
			}
		}
		// `sort_field` names a field of this collection's OWN schema. Without this gate a typo
		// surfaces as "dragging does nothing" while the drag handle is still offered — a silent lie,
		// and the ordering it writes would land in a field no reader sorts by.
		if (merged.sort_field !== undefined) {
			if (typeof merged.sort_field !== 'string') fail(`collection "${name}": sort_field must be a string (got ${JSON.stringify(merged.sort_field)})`);
			if (!(merged.schema?.properties ?? {})[merged.sort_field]) {
				fail(`collection "${name}": sort_field "${merged.sort_field}" is not a field of its schema — declare it, or point sort_field at one that exists (${group.map((g) => g.src.path).join(', ')}).`);
			}
		}
		// ---- the reference contract: every target is owned, depended on, or declared a peer ----
		// Attribution is unioned across the whole group rather than taken from the base, because the
		// merge keeps no per-field provenance — an overlay that adds a ref field would otherwise be
		// judged against the BASE module's declarations, which it never wrote.
		const groupModules = [...new Set(group.map((g) => g.moduleName))];
		// WHO OWNS the concept — the module whose source is the base, not the ones overlaying it.
		// An overlay adds fields to somebody else's collection (a workspace module adding its own
		// `tags` to the `crm` module's `contacts`);
		// it does not take the concept over. Measured 2026-08-11: letting the overlay win moves
		// `contacts` and `meetings` out of CRM, and a CRM without contacts reads as broken.
		//
		// ⚠ This is NOT the `module` provenance field an outside review rejected this morning. That
		// one duplicated `group:` while claiming to name every contributor, and got the merged case
		// wrong by taking the first source. This names ONE thing — the owner — for which the base
		// IS the answer, and it exists to REPLACE `group:` as the workspace's partition rather than
		// to sit beside it.
		merged.owner = `modules/${moduleId(base?.moduleName ?? groupModules[0])}`;
		// EVERY contributing module, not just the base — a collection merged from `crm` and the
		// workspace module that overlays it belongs
		// to both, and saying otherwise is what made a flat "which module owns this" field wrong.
		for (const m of groupModules) {
			if (!moduleColls.has(m)) moduleColls.set(m, new Set());
			moduleColls.get(m).add(name);
		}
		const declaredDeps = new Set(groupModules.flatMap((m) => moduleDeps.get(m) ?? []));
		const declaredPeers = new Set(groupModules.flatMap((m) => modulePeers.get(m) ?? []));
		const owns = (t) => groupModules.includes(collOwner.get(t));
		// what THIS collection actually points at — see `unresolved_peers` below
		const referenced = new Set();
		normalizeRelationKeywords(merged.schema, name);
		for (const [at, raw] of refTargets(merged.schema)) {
			if (raw === '*') {
				// The workspace module is the orchestrating parent and may reference anything —
				// including modules that do not exist yet, which is what `tasks.item` means.
				// Anywhere else a wildcard is a cross-module surface no declaration can cover.
				if (!groupModules.includes(wsModuleName)) {
					console.warn(`⚠ collection ${name}: field "${at}" uses x-reference: '*' outside the workspace module — an unverifiable cross-module surface; name the collections it may target`);
				}
				continue;
			}
			// `x-reference` accepts a scalar or a LIST of targets (the union) — run the identical
			// per-target contract check over every member.
			const targets = Array.isArray(raw) ? raw : [raw];
			// scalar-or-list: the list is the union form. '*' may not appear INSIDE a list — the
			// wildcard is a scalar-only sentinel, and a union that includes "anything" is not a union.
			if (targets.length === 0 || targets.some((t) => typeof t !== 'string' || t === '' || t === '*')) {
				fail(`collection "${name}": field "${at}" has an invalid x-reference ${JSON.stringify(raw)} — expected a collection name, a non-empty list of collection names, or '*'.`);
			}
			for (const target of targets) {
				referenced.add(target);
				if (CORE_COLLECTIONS.has(target) || owns(target)) continue;
				const owner = collOwner.get(target);
				if (owner && declaredDeps.has(owner)) continue;
				if (declaredPeers.has(target)) continue;
				const fix = owner
					? `add "${owner}" to dreamteamer.dependencies, or "${target}" to dreamteamer.peerDependencies if the module should work without it`
					: `add "${target}" to dreamteamer.peerDependencies — no installed module provides it`;
				fail(`collection "${name}": field "${at}" references "${target}", which ${groupModules.join('/')} neither owns nor declares.\n  ${fix}.`);
			}
		}
		// Declared peers that nothing provides, stated as DATA on the descriptor so `check` can
		// excuse their references without learning what a module is (the `storage.base` precedent —
		// check.js is in the record layer and must not know modules exist).
		//
		// ⚠ Only the peers THIS collection references. It used to be every peer the module declared,
		// stamped onto every collection in it — which made the field a module-level fact wearing a
		// collection-level key, and handed a collection that references nothing an excuse it can
		// never legitimately use. A peer declared for one collection would then have silently excused
		// a typo'd reference in a sibling.
		const unresolved = [...declaredPeers].filter((p) => referenced.has(p) && !collOwner.has(p)).sort();
		if (unresolved.length) merged.unresolved_peers = unresolved;

		// ONE BODY PER COLLECTION. A record's prose is the text after the frontmatter — there is only
		// one of it — so a second `x-body` is a descriptor asking for something the file format cannot
		// hold. Nothing refused it before, and the consequence was silent rather than loud: every
		// reader picks the FIRST such property (store.js `bodyField`, check.js, applyTemplate above),
		// so the second field simply never receives the body, and `serialize` then writes the prose
		// back under the first key — moving the record's content to a different field on its next
		// write. Refused here, where both spellings (authored, or `--body` twice) arrive.
		const bodies = bodyKeys(merged.schema);
		if (bodies.length > 1) {
			fail(`collection "${name}": ${bodies.length} fields declare x-body (${bodies.join(', ')}) — a record has ONE body, the text after its frontmatter. Keep one and drop x-body from the rest.`);
		}

		mergedGroups.set(name, { merged, sources: [...group.map((g) => g.src), ...templateSources] });
		if (extenders.length) mergedCount++;
	}

	// ---- relations: one compiled shape from either source spelling -------------------
	// Between the per-collection loop and the dump, because it is the first moment every descriptor
	// exists and the last moment before bytes are fixed — a relation writes to a collection OTHER
	// than the one that declares it, so no per-collection pass can express it.
	materializeRelations(mergedGroups, {
		moduleDeps, wsModuleName,
		moduleOf: (n) => collOwner.get(n),
	});

	// ---- resolved labels, then bytes -------------------------------------------------
	// A second loop rather than a tail of the first: generated mirror fields do not exist until the
	// pass above has run, and a field with no `title` renders as a raw key in every surface that
	// draws one.
	for (const [name, { merged, sources: descriptorSources }] of mergedGroups) {
		// ---- resolved labels: what to CALL this collection, its records and its fields --------
		// Written into the artifact next to `storage.base` and for the same reason: the nav, the
		// browse page, the CLI and the extension then read ONE field instead of each carrying its
		// own title-caser. Authored values always win — `??=` never overwrites. After the ajv gate
		// on purpose: a malformed property must fail as a bad schema, not as a TypeError here.
		// ⚠ From the BARE name, not the qualified one. A namespace is the FOLDER a collection sits in,
		// not part of what it is called — every surface that draws the namespace as a folder was
		// otherwise saying it twice on one screen ("R&D > Rnd Prototypes", "Family > Health >
		// Health Documents"). Workspaces had already worked around it by hand-authoring a title on
		// every namespaced collection, which is the tell: a derivation nobody can use is not a
		// default. `baseNameOf` resolves against the DECLARED list, so an undeclared prefix — which
		// is not a namespace — keeps its whole name in the label.
		merged.title ??= titleCase(baseNameOf(name, namespaces));
		const labelProps = merged.schema?.properties ?? {};
		// how a RECORD of this collection is labelled — the probe presentation.js has always used
		// for `meta.title_field`, promoted to an authorable field. Reference fields pointing here
		// inherit it (presentation.js), which is what replaces 51 hand-written `x-display` lines.
		merged.title_template ??= `{{ ${['title', 'name', 'subject'].find((f) => f in labelProps) ?? 'id'} }}`;
		for (const [fieldName, prop] of Object.entries(labelProps)) {
			if (!prop || typeof prop !== 'object' || Array.isArray(prop)) continue;
			prop.title ??= titleCase(fieldName);
			// `x-unique` MEANS SOMETHING ONLY ON A RELATION, and everywhere else it is silently inert.
			// It is not a JSON Schema keyword, so ajv ignores it; `relationsOf` decodes a relation from
			// `x-inverse`, so with no mirror there is no relation row — and therefore no constraint in
			// `check` (which tests uniqueness per relation) and none at write time (the store enforces
			// it while maintaining a mirror). A descriptor asking for a one-to-one and getting nothing
			// at all, with nothing to read. ⚠ A WARNING, not a failure: it breaks nothing today, and a
			// workspace already carrying one must not be stopped from compiling by a diagnosis of it.
			// Read AFTER materializeRelations, so a folded spelling-B field is already gone and a
			// generated mirror (which never carries x-unique) cannot trip it.
			const h = (prop.items && typeof prop.items === 'object') ? prop.items : prop;
			if (h['x-unique'] === true && h['x-inverse'] === undefined && h['x-inverse-of'] === undefined) {
				console.warn(`⚠ collection ${name}: x-unique on "${fieldName}" is inert — it is a RELATION keyword, enforced only while the store maintains a mirror, and this field declares no x-inverse. Nothing constrains the value. Declare the relation (dreamteamer schema update-field ${name} --name ${fieldName} --inverse) or drop x-unique.`);
			}
		}
		const rt = path.join('collections', `${name}.collection.yaml`);
		entries.set(rt, { sources: descriptorSources, bytes: Buffer.from(dump(merged)) });
		// A descriptor with no `description:` renders in the orientation block as a bare NAME — an
		// agent learns the noun exists and nothing about when it is the right one. Derived pressure
		// rather than a heroic backfill pass, and the same shape as the per-missing-env-key warning:
		// non-blocking, named per offender, so the gap converges instead of being rediscovered.
		//
		// ⚠ Deliberately NO equivalent warning for `use_when`. That field is optional and correct to
		// omit on most collections — warning on it would invert its authoring test and manufacture a
		// restatement of the description on every collection that does not need one.
		if (merged.storage.base !== 'runtime' && !String(merged.description ?? '').trim()) {
			console.warn(`⚠ collection ${name} has no description — it renders as a bare name in the orientation block every session loads`);
		}
		counts.collections++;
	}

	// ---- no collection may sit inside another's folder -------------------------------
	// Checked HERE because it is the first moment every path is resolved (namespace nesting, the
	// `owns-data` module prefix and any authored override all already applied). See
	// namespace.storageOverlaps for what this silently did before it was checked.
	for (const p of storageOverlaps(storageEntries)) fail(p);

	// ---- modules, projected ---------------------------------------------------------
	// One record per discovered module, written from what discovery and the package pass already
	// established. `package.json` remains the source of truth and compile keeps reading it — this
	// is a photograph, never an input (see collections/modules.collection.yaml for why it earns a
	// place in core at all).
	//
	// The id strips an npm scope so `@dreamteamer/crm` reads as `crm`, which is what every message
	// in this engine already calls it. A collision is a hard failure rather than a silent overwrite:
	// two modules answering to one id would make `dependencies` ambiguous, and an ambiguous edge is
	// worse than no diagram.
	const idByModule = new Map();
	for (const source of sources) {
		const id = moduleId(source.name);
		const clash = idByModule.get(id);
		if (clash && clash !== source.name) fail(`modules "${clash}" and "${source.name}" both resolve to the id "${id}" — rename one.`);
		idByModule.set(id, source.name);
	}
	for (const source of sources) {
		const id = moduleId(source.name);
		let mpkg = {};
		try { mpkg = JSON.parse(fs.readFileSync(path.join(source.root, 'package.json'), 'utf8')).dreamteamer ?? {}; } catch { /* inline workspace source */ }
		const record = {
			name: source.name,
			// Authored wins; the derived fallback title-cases the id the same way a collection's
			// `title` is derived. `@dreamteamer/crm` -> "Crm" until crm declares "CRM" — which is
			// the point: the module is the only place that knows.
			title: typeof mpkg.title === 'string' && mpkg.title ? mpkg.title : titleCase(id),
			channel: source.channel,
			path: rel(source.root) || '.',
			...(mpkg['owns-data'] === true ? { owns_data: true } : {}),
			// Declared module names become record IDS here, because that is what an x-reference
			// resolves against. An undeclared/unknown name would dangle, and `check` would say so —
			// but compile has already failed on that case (the acyclicity pass resolves every one).
			// ⚠ A reference VALUE is `<collection>/<id>`, never a bare id — `check` rejects the bare
			// form, which is exactly what it did to the first pass of this projection (63 violations).
			...(moduleDeps.get(source.name)?.length
				? { dependencies: moduleDeps.get(source.name).map((n) => `modules/${moduleId(n)}`) }
				: {}),
			...(modulePeers.get(source.name)?.length
				? { peer_dependencies: modulePeers.get(source.name).map((c) => `collections/${c}`) }
				: {}),
			...(moduleColls.get(source.name)?.size
				? { collections: [...moduleColls.get(source.name)].sort().map((c) => `collections/${c}`) }
				: {}),
		};
		const bytes = Buffer.from(dump(record));
		// ⚠ The source hash is the hash of the SOURCE FILE, not of the projected record. Hashing the
		// output made every source "differ" on the next run, so `staleness` reported the workspace
		// stale immediately after a clean compile — the one signal that has to stay trustworthy.
		const pkgPath = path.join(source.root, 'package.json');
		const pkgBytes = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath) : bytes;
		entries.set(path.join('modules', `${id}.module.yaml`), {
			sources: [{ path: rel(pkgPath), hash: sha256(pkgBytes) }],
			bytes,
		});
		counts.modules = (counts.modules ?? 0) + 1;
	}

	// ---- unresolved references are compile errors (an agent's declared skills)
	const skillIds = new Set([...entries.keys()].filter((k) => k.startsWith('skills/')).map((k) => k.split('/')[1]));
	for (const [rt, e] of entries) {
		if (rt.startsWith('agents/')) {
			const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(e.bytes.toString('utf8'));
			const doc = fm ? load(fm[1]) : {};
			for (const sk of doc.skills ?? []) {
				if (!skillIds.has(String(sk).replace(/^skills\//, ''))) fail(`${rt}: references unknown skill "${sk}"`);
			}
		}
	}
	if (disabledHits.size < disabled.size) {
		for (const d of disabled) if (!disabledHits.has(d)) console.warn(`⚠ dreamteamer.disable entry "${d}" matched nothing`);
	}

	// ---- ui-view layout validation --------------------------------------------------
	// ⚠ `layout` is NOT validated here, deliberately. The rule: the engine validates a value if and
	// only if the ENGINE INTERPRETS it. It interprets filter operators (`matchesFilter`, and the
	// CLI's `--where`), so a typo'd operator is a real bug it can catch — hence the check below.
	// It interprets `layout` nowhere: the value is opaque payload forwarded to whichever surface
	// renders, and only that surface's registry knows which ids exist.
	//
	// There used to be an allowlist here, hardcoded to mirror dreamteamer-vscode's
	// `lists.register(...)` calls in a DIFFERENT REPO. It was wrong both times it was tested:
	// kanban/calendar/map (2026-07-29) and erd/graph (2026-08-10), each costing an engine edit to
	// add a UI feature. Worse, it BLOCKED the sanctioned extension path — a module's `app.js` gets
	// a `registerList({ id, ... })` API, so it can contribute a layout with no engine involvement,
	// and this check then rejected the very view naming it unless the module also duplicated the id
	// into a `dreamteamer.studio.layouts` key (zero users, in any repo, ever). Proven 2026-08-11 by
	// modules/ui-smoke: the layout rendered in the app while compile refused the view.
	//
	// The descriptor already documented the correct behaviour — ui-views.collection.yaml: "An
	// unregistered id degrades visibly rather than erroring" — and the surface already implements
	// it (presets.ts#resolveRendererEntry falls back to table). Decision 195.
	// ui-views' own field names, read from the descriptor that was just merged rather than hardcoded —
	// a list in here would silently stop covering a field the moment ui-views grew one.
	const ownFields = load(entries.get(path.join('collections', 'ui-views.collection.yaml'))?.bytes?.toString('utf8') ?? '')?.schema?.properties ?? {};
	for (const [rt, e] of entries) {
		if (!rt.startsWith('ui-views/')) continue;
		const view = load(e.bytes.toString('utf8'));
		// filters are load-bearing (they narrow what the operator SEES) — typo'd operators
		// fail at compile, not silently at render (review finding 5)
		const badOps = view?.filter ? [...unknownOperators(view.filter)] : [];
		if (badOps.length) fail(`${rt}: unknown filter operator(s) ${badOps.join(', ')}`);
		// `@me` died with the `users` collection in 0.8.0. It expanded to `users/<slug>`, so on this
		// engine it can only ever match nothing — and a filter that narrows to zero rows is the exact
		// silent failure this block exists to prevent. Refuse it by name, with the fix.
		if (view?.filter && JSON.stringify(view.filter).includes('"@me"')) {
			fail(`${rt}: filter uses "@me", which was removed with the \`users\` collection in 0.8.0 — it would now match nothing.\n  filter on a field this workspace owns instead (e.g. { status: { _eq: "todo" } }).`);
		}
		// ⚠ `options` is a deliberately OPEN object — every key it does not own rides through untouched
		// to whichever surface renders the layout. That openness is right, and it has one sharp edge: a
		// field that belongs ONE LEVEL UP, written inside it, is accepted, saved, round-tripped and read
		// by nobody. `options.filter` cost a real afternoon — the view drew all 429 rows of a collection
		// it was supposed to narrow to 90, and neither compile nor check nor the surface said a word.
		//
		// This is the same rule the block above states, not an exception to it: the engine DOES interpret
		// `filter`, so a `filter` it will never be handed is a value it can catch. A warning rather than a
		// failure because `options` is open by contract and a surface may legitimately want a key that
		// collides — but the operator has to be told, because the symptom is a view that looks like it
		// works.
		const shadowed = view?.options && typeof view.options === 'object' && !Array.isArray(view.options)
			? Object.keys(view.options).filter((k) => k in ownFields)
			: [];
		for (const k of shadowed) {
			console.warn(`⚠ ${rt}: options.${k} is read by nothing — \`${k}\` is a field of ui-views itself, one level up. move it out of \`options\`.`);
		}
	}

	// ---- command-binding validation --------------------------------------------------
	// a binding joins a command to a collection under can-enter/can-exit predicates;
	// dangling refs and typo'd operators fail HERE, not silently at evaluation (the same
	// guarantee ui-view filters get — validators are load-bearing, they gate what runs).
	const commandIds = new Set([...entries.keys()].filter((k) => k.startsWith('commands/')).map((k) => path.basename(k).replace(/\.command\.md$/, '')));
	for (const [rt, e] of entries) {
		if (!rt.startsWith('command-bindings/')) continue;
		const b = load(e.bytes.toString('utf8'));
		const cmd = String(b?.command ?? '').replace(/^commands\//, '');
		if (!cmd || !commandIds.has(cmd)) fail(`${rt}: references unknown command "${b?.command ?? ''}"`);
		const coll = String(b?.collection ?? '').replace(/^collections\//, '');
		if (!coll || !descriptorGroups.has(coll)) fail(`${rt}: references unknown collection "${b?.collection ?? ''}"`);
		for (const key of ['can-enter', 'can-exit']) {
			const badBindOps = b?.[key] ? [...unknownOperators(b[key])] : [];
			if (badBindOps.length) fail(`${rt}: ${key} has unknown filter operator(s) ${badBindOps.join(', ')}`);
			if (b?.[key] && b?.target === 'collection') console.warn(`⚠ ${rt}: ${key} is ignored — target=collection bindings evaluate no record`);
		}
	}

	// ---- materialize .dreamteamer ------------------------------------------------
	// mkdir the runtime ROOT unconditionally: with zero entries nothing below created it, so the
	// manifest write at the end failed ENOENT — `init` followed by `compile` in a fresh workspace
	// crashed on the one path a new user takes first.
	fs.mkdirSync(RUNTIME, { recursive: true });
	// clear each kind's folder, plus `system/` — a runtime compiled by a pre-flatten engine has the
	// whole tree under there, and leaving it would keep stale descriptors on disk beside the fresh
	// ones. Never `rm -rf` the runtime root itself: it also holds the write lock.
	// ⚠ DERIVED_KINDS too, not just KINDS. `modules/` is projected rather than staged, so it was not
	// in this loop and never got cleared — a module that was RENAMED or REMOVED left its old record
	// behind forever, listing collections that no longer exist. `check` reads those records like any
	// other, so it surfaced as a dangling reference in a file nobody had touched, twice in one day
	// (the workspace module's own record after it was renamed, and a domain module's after it was
	// folded into another). The
	// runtime is build output; stale build output is the compiler's problem, not the reader's.
	for (const kind of [...KINDS, ...DERIVED_KINDS]) fs.rmSync(path.join(RUNTIME, kind), { recursive: true, force: true });
	fs.rmSync(path.join(RUNTIME, 'system'), { recursive: true, force: true });
	fs.rmSync(path.join(RUNTIME, 'ui'), { recursive: true, force: true });
	for (const [rt, e] of entries) {
		const dest = path.join(RUNTIME, rt);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, e.bytes);
	}

	// ---- harness adapters (dispatch table lives in harnesses.js) -------------------
	const prevManifest = readManifest(root);
	// What the harness blocks should TELL an agent about where sources live — measured, not assumed.
	// A workspace still on the nested layout was being handed prose naming the flat one, and that
	// block is the first thing a session reads.
	const anyFlat = sources.some((s) => KINDS.some((k) => fs.existsSync(path.join(s.root, k))));
	const anyNested = sources.some((s) => KINDS.some((k) => fs.existsSync(path.join(s.root, 'system', k))));
	const sourceLayout = anyFlat && anyNested ? 'mixed' : anyNested ? 'nested' : 'flat';
	const { outputs: adapterOutputs, summary: harnessSummary } = runHarnessAdapters({ root, entries, harnesses, prevManifest, sourceLayout, namespaces, version: engineVer });

	// ---- provenance manifest ------------------------------------------------------
	const manifest = {
		compiled: new Date().toISOString(),
		host: engineId(),
		// The declared namespace list, carried across the boundary so the RECORD layer can split a
		// reference without importing the compiler or re-reading package.json — the same reason
		// `storage.base` is a field instead of a path test. An older runtime has no key here, which
		// reads as "no namespaces", which is exactly right for a workspace that never declared any.
		namespaces,
		modules: sources.map((s) => ({ name: s.name, channel: s.channel, root: rel(s.root) || '.' })),
		ui: uiModules.sort(),
		'adapter-outputs': adapterOutputs.sort(),
		entries: Object.fromEntries(
			[...entries].map(([rt, e]) => [rt, { sources: e.sources, hash: sha256(e.bytes) }]) // sources: [{path, hash}] — per-SOURCE hashes power staleness
		),
	};
	fs.writeFileSync(path.join(RUNTIME, 'manifest.yaml'), dump(manifest));

	const summary = KINDS.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}${k === 'collections' && mergedCount ? ` (${mergedCount} merged)` : ''}`).join(', ');
	const sourceLabel = config['workspace-module']
		? `${sources.length} module(s) (workspace-module: ${config['workspace-module']})`
		: `${sources.length - 1} module(s) + workspace`;
	console.log(`✔ compiled ${summary || 'nothing'} from ${sourceLabel} → .dreamteamer`);
	for (const line of harnessSummary) console.log(`✔ harness ${line}`);
	return 0;
}

function engineId() {
	try {
		const p = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		return `${p.name}@${p.version}`;
	} catch { return 'dreamteamer@unknown'; }
}

// bare version of the RUNNING engine (dev clone or installed copy — whichever loaded)
export function engineVersion() {
	return engineId().split('@').pop();
}

// staleness: does any manifest entry's SOURCE differ from what was compiled, or is a
// source file missing/new? used by `status` and warned about at every tool entry.
export function staleness(root) {
	const manifest = readManifest(root);
	if (!manifest) return { compiled: false, stale: [], message: 'no compiled runtime — run `dreamteamer compile`' };
	const stale = [];
	for (const [rt, e] of Object.entries(manifest.entries ?? {})) {
		for (const src of e.sources) {
			// sources are {path, hash}; tolerate the pre-merge string form
			const srcPath = typeof src === 'string' ? src : src.path;
			const srcHash = typeof src === 'string' ? e.hash : src.hash;
			const p = path.join(root, srcPath);
			if (!fs.existsSync(p)) stale.push(`${srcPath} (removed)`);
			else if (sha256(fs.readFileSync(p)) !== srcHash) stale.push(`${srcPath} (changed)`);
		}
	}
	// new source files not present in the manifest — scan winning module roots across
	// ALL channels (shadowed copies were not compiled, so their files are not "new")
	const known = new Set(Object.values(manifest.entries ?? {}).flatMap((e) => e.sources.map((s) => (typeof s === 'string' ? s : s.path))));
	let pkg = {};
	try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* no pkg */ }
	const wm = pkg.dreamteamer?.['workspace-module'];
	const roots = [...(wm ? [] : [root]), ...discoverModules(root, pkg).modules.map((m) => m.root)];
	for (const r of roots) {
		for (const kind of KINDS) {
			const dir = kindDir(r, kind);
			if (!fs.existsSync(dir)) continue;
			for (const f of walk(dir)) {
				const relPath = path.relative(root, f);
				if (!known.has(relPath)) stale.push(`${relPath} (new, uncompiled)`);
			}
		}
	}
	return { compiled: true, stale, manifest };
}

export function warnIfStale(root) {
	const s = staleness(root);
	if (!s.compiled) console.warn(`⚠ ${s.message}`);
	else if (s.stale.length) console.warn(`⚠ .dreamteamer is stale (${s.stale.length} source(s) differ) — run \`dreamteamer compile\``);
	return s;
}


// `templates:` merge — the DESCRIPTOR always wins, and its own key order is preserved (unlike
// mergeDescriptor, whose extender wins). Two properties of this that matter:
//
//   - the descriptor keeps `extends` and `name`: losing `extends` would silently demote an overlay
//     to a second base and collide with the real one.
//   - template-added properties are inserted BEFORE the x-body property, not appended after it.
//     Property order is form order in the studio, and the record's body belongs last — metadata
//     about a record should not render below the record's content.
function applyTemplate(doc, tpl) {
	const out = structuredClone(doc);
	for (const [k, v] of Object.entries(tpl)) {
		if (k === 'schema') continue;
		if (out[k] === undefined) out[k] = structuredClone(v);
	}
	if (!tpl.schema) return out;
	out.schema ??= { type: 'object' };
	for (const [sk, sv] of Object.entries(tpl.schema)) {
		if (sk === 'properties') {
			const own = out.schema.properties ?? {};
			const add = Object.entries(sv).filter(([pk]) => own[pk] === undefined);
			const bodyKey = bodyKeys({ properties: own })[0];
			const merged = {};
			for (const [pk, pv] of Object.entries(own)) {
				if (pk === bodyKey) for (const [ak, av] of add) merged[ak] = structuredClone(av);
				merged[pk] = pv;
			}
			if (!bodyKey) for (const [ak, av] of add) merged[ak] = structuredClone(av);
			out.schema.properties = merged;
		} else if (sk === 'required') {
			out.schema.required = [...new Set([...(out.schema.required ?? []), ...sv])];
		} else if (out.schema[sk] === undefined) out.schema[sk] = sv;
	}
	return out;
}

/** Which module supplied the descriptor's WINNING storage block. mergeDescriptor lets an
 *  extender win on any non-schema key (`else out[k] = v`), so "storage comes from the base" is
 *  the default, not a guarantee — an overlay that declares its own storage overrides it, and
 *  ownership must follow the block that actually survived. */
function storageOwnerOf(group, base) {
	let owner = base.moduleName;
	for (const g of group) if (g.doc.extends && g.doc.storage) owner = g.moduleName;
	return owner;
}

// extends merge: schema.properties merge per-property, required unions, other
// keys extender-wins; storage/id come from the base unless explicitly overridden.
function mergeDescriptor(base, ext) {
	const out = structuredClone(base);
	for (const [k, v] of Object.entries(ext)) {
		if (k === 'extends' || k === 'name') continue;
		if (k === 'schema') {
			out.schema ??= { type: 'object', properties: {} };
			for (const [sk, sv] of Object.entries(v)) {
				if (sk === 'properties') out.schema.properties = { ...out.schema.properties, ...sv };
				else if (sk === 'required') out.schema.required = [...new Set([...(out.schema.required ?? []), ...sv])];
				else out.schema[sk] = sv;
			}
		} else out[k] = v;
	}
	return out;
}

// a bad source THROWS (review finding 8: process.exit killed --watch on the first typo
// and made server-triggered recompiles impossible). the CLI boundary prints and exits.
export class CompileError extends Error {}

let _descriptorAjv = null;
function descriptorAjv() {
	if (!_descriptorAjv) {
		_descriptorAjv = new Ajv({ allErrors: true, strict: false });
		addFormats(_descriptorAjv);
		_descriptorAjv.addFormat('markdown', true);
	}
	return _descriptorAjv;
}

function fail(msg) {
	throw new CompileError(`compile error: ${msg}`);
}
