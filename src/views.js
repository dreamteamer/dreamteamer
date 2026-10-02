// ui-views and command-bindings — validated against the collection they name, and a view's display
// resolved over that collection's.
//
// A view is a named variant of a collection's default view: it carries the same `display` block a
// collection does, and compile merges it over the collection's sub-block by sub-block, a key the
// view sets winning. A binding joins a command to a collection and gates it on the record's own
// fields (`available_when`, `done_when`). Both are checked here, in their own vocabulary, against
// the fields of the collection they name, so a dangling name is a compile error naming the
// position rather than a view that draws nothing or a gate that never opens.
//
// A name a module may legitimately not see yet — a field an overlay of an absent PEER collection
// adds — is reported as a warning instead when the caller says the module declares an absent peer:
// the condition then reads as not met, which is the peer contract.
//
// Pure: no fs, no git. Errors are returned, never thrown, so compile attributes each to a file.
import { unknownOperators, unknownTokens, VALUE_TOKENS } from './filter.js';
import { validateTemplate } from './template.js';

/** The keys a ui-view carries, in canonical order. `compiled` is compile's, never authored. */
export const VIEW_KEYS = ['name', 'title', 'description', 'route', 'scope', 'collection', 'filter', 'display'];
export const VIEW_SCOPES = ['record', 'collection', 'page'];
/** A view's display: the collection's four sub-blocks, with `nav.title` because a view has no
 *  descriptor title of its own, and `options` on the record page as well as the list. */
export const VIEW_DISPLAY = {
	nav: ['title', 'icon', 'order'],
	list: ['layout', 'columns', 'sort', 'options'],
	record: ['layout', 'subtitle', 'badge', 'color_by', 'options'],
	form: ['sections'],
};
/** Layout options that take a FIELD, named for the role it plays; and the ones that take a template. */
export const FIELD_OPTIONS = ['color_by', 'group_by', 'lanes_by', 'start', 'end', 'lat', 'lng'];
export const TEMPLATE_OPTIONS = ['card_title', 'bar_title', 'group_title', 'group_summary'];
const GROUP_TEMPLATES = ['group_title', 'group_summary'];

/** The keys a command-binding carries. */
export const BINDING_KEYS = ['command', 'collection', 'scope', 'available_when', 'done_when', 'description'];
export const BINDING_SCOPES = ['record', 'collection'];

// what marks a source as written in the format before this one: only ever used to send it to the
// converter, which compile names once for every such file (`v1: true` on the result)
const V1_VIEW_KEYS = ['path', 'target', 'layout', 'options', 'nav'];
const V1_BINDING_KEYS = ['target', 'can-enter', 'can-exit'];

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const BUILTIN_FIELDS = ['id', 'created', 'last_modified'];

/**
 * Validate one ui-view.
 * @param {object} view
 * @param {{ file: string, fields?: object, lenient?: boolean }} ctx
 *   fields  — the named collection's resolved fields, or undefined when it is not known here (an
 *             unknown collection is `check`'s to report, through the reference)
 *   lenient — the view's module declares a peer collection that is not installed
 * @returns {{ errors: string[], warnings: string[], v1?: true }} each naming its position
 */
export function viewErrors(view, { file, fields, groupFields, lenient = false }) {
	if (!isMap(view)) return { errors: [`${file}: a ui-view is a mapping`], warnings: [] };
	if (V1_VIEW_KEYS.some((k) => k in view) && !('route' in view || 'scope' in view || 'display' in view)) return { v1: true, errors: [], warnings: [] };
	const errors = [];
	const names = [];
	const at = (msg) => errors.push(`${file}: ${msg}`);
	for (const k of Object.keys(view)) {
		if (VIEW_KEYS.includes(k)) continue;
		if (k === 'default') at('`default` — a view is always a named variant; the collection\'s own `display` is its default view. Move this view\'s display into the collection\'s descriptor, or drop the key.');
		else at(`unknown key \`${k}\` — a ui-view's keys are ${VIEW_KEYS.join(' · ')}`);
	}
	if (typeof view.route !== 'string' || !view.route.startsWith('/')) at('`route` is required: the path this view renders at, starting with /');
	if (!VIEW_SCOPES.includes(view.scope)) at(`\`scope\` is required: ${VIEW_SCOPES.join(' · ')}`);
	if (view.scope !== 'page' && typeof view.collection !== 'string') at('`collection` is required for a record or collection view: collections/<name>');
	if (view.filter !== undefined) {
		if (!isMap(view.filter)) at('`filter` is a mapping of field → condition');
		else {
			const bad = [...unknownOperators(view.filter)];
			if (bad.length) at(`filter: unknown filter operator(s) ${bad.join(', ')}`);
			const tokens = [...unknownTokens(view.filter)];
			if (tokens.length) at(`filter holds unknown value token(s) ${tokens.join(', ')} — the tokens are ${VALUE_TOKENS.join(' and ')}`);
			if (fields) for (const f of filterFields(view.filter)) if (!has(fields, f)) names.push(`${file}: filter names "${f}", which is not a field of ${view.collection}`);
		}
	}
	const warnings = [];
	if (view.display !== undefined) displayErrors(view.display, { fields, groupFields, collection: view.collection, errors, names, warnings, file });
	return lenient ? { errors, warnings: [...warnings, ...names] } : { errors: [...errors, ...names], warnings };
}

function displayErrors(display, { fields, groupFields, collection, errors, names: dangling, warnings, file }) {
	const err = (m) => errors.push(`${file}: ${m}`);
	if (!isMap(display)) return err('`display` is a mapping of nav · list · record · form');
	const names = fields ? [...Object.keys(fields), ...BUILTIN_FIELDS] : null;
	const field = (pos, f) => { if (names && !names.includes(String(f).replace(/^-/, ''))) dangling.push(`${file}: ${pos} names "${f}", which is not a field of ${collection}`); };
	const template = (tpl, position, over = names) => { for (const e of validateTemplate(tpl, { position, fields: over })) (/is not a field/.test(e) ? dangling : errors).push(`${file}: ${e}`); };
	for (const [b, v] of Object.entries(display)) {
		if (!VIEW_DISPLAY[b]) { err(`unknown key \`display.${b}\` — display has ${Object.keys(VIEW_DISPLAY).join(' · ')}`); continue; }
		if (!isMap(v)) { err(`\`display.${b}\` is a mapping`); continue; }
		for (const k of Object.keys(v)) if (!VIEW_DISPLAY[b].includes(k)) err(`unknown key \`display.${b}.${k}\` — ${b} has ${VIEW_DISPLAY[b].join(' · ')}`);
		if (v.columns !== undefined) {
			if (!Array.isArray(v.columns)) err(`display.${b}.columns is a list of field names`);
			else for (const c of v.columns) field(`display.${b}.columns`, c);
		}
		if (v.sort !== undefined && v.sort !== '') field(`display.${b}.sort`, v.sort);
		for (const k of ['badge', 'color_by']) if (v[k] !== undefined) field(`display.${b}.${k}`, v[k]);
		if (v.subtitle !== undefined && names) template(v.subtitle, `display.${b}.subtitle`);
		for (const [i, s] of (Array.isArray(v.sections) ? v.sections : []).entries()) for (const f of s?.fields ?? []) field(`display.${b}.sections[${i}]`, f);
		if (v.options !== undefined) {
			if (!isMap(v.options)) { err(`display.${b}.options is a mapping`); continue; }
			// options is open — each layout reads its own keys, and a surface may want one that collides —
			// but a key of the block or of the view itself, written down here, is read by nobody
			for (const k of Object.keys(v.options)) {
				if (VIEW_DISPLAY[b].includes(k)) warnings.push(`${file}: display.${b}.options.${k} is read by nothing — \`${k}\` is a key of display.${b}, one level up`);
				else if (VIEW_KEYS.includes(k)) warnings.push(`${file}: display.${b}.options.${k} is read by nothing — \`${k}\` is a key of the view itself, at the top`);
			}
			for (const k of FIELD_OPTIONS) if (v.options[k] !== undefined) field(`display.${b}.options.${k}`, v.options[k]);
			for (const k of TEMPLATE_OPTIONS) {
				if (v.options[k] === undefined || !names) continue;
				// a group's title and summary render over the record the rows are grouped BY — the target of
				// a reference group_by — so they are checked against that collection, or not at all
				if (GROUP_TEMPLATES.includes(k)) {
					const over = groupFields?.(v.options.group_by);
					if (over) template(v.options[k], `display.${b}.options.${k}`, [...Object.keys(over), ...BUILTIN_FIELDS]);
				} else template(v.options[k], `display.${b}.options.${k}`);
			}
		}
	}
}

/**
 * Validate one command-binding.
 * @returns {{ errors: string[], warnings: string[], v1?: true }}
 */
export function bindingErrors(b, { file, fields, lenient = false }) {
	if (!isMap(b)) return { errors: [`${file}: a command-binding is a mapping`], warnings: [] };
	if (V1_BINDING_KEYS.some((k) => k in b)) return { v1: true, errors: [], warnings: [] };
	const errors = [];
	const warnings = [];
	for (const k of Object.keys(b)) if (!BINDING_KEYS.includes(k)) errors.push(`${file}: unknown key \`${k}\` — a command-binding's keys are ${BINDING_KEYS.join(' · ')}`);
	if (b.scope !== undefined && !BINDING_SCOPES.includes(b.scope)) errors.push(`${file}: \`scope\` is ${BINDING_SCOPES.join(' · ')}`);
	for (const key of ['available_when', 'done_when']) {
		if (b[key] === undefined) continue;
		if (!isMap(b[key])) { errors.push(`${file}: \`${key}\` is a mapping of field → condition`); continue; }
		const bad = [...unknownOperators(b[key])];
		if (bad.length) errors.push(`${file}: ${key} has unknown filter operator(s) ${bad.join(', ')}`);
		const tokens = [...unknownTokens(b[key])];
		if (tokens.length) errors.push(`${file}: ${key} holds unknown value token(s) ${tokens.join(', ')} — the tokens are ${VALUE_TOKENS.join(' and ')}`);
		if (fields) for (const f of filterFields(b[key])) if (!has(fields, f)) (lenient ? warnings : errors).push(`${file}: ${key} names "${f}", which is not a field of ${b.collection}`);
		if (b.scope === 'collection') warnings.push(`${file}: ${key} is read by nothing — a collection-scope binding evaluates no record`);
	}
	return { errors, warnings };
}

/** The field names a filter conditions on at its top level, through `_and` / `_or`. A nested
 *  non-operator key is a field of the referenced record, which only that collection can judge. */
function filterFields(filter) {
	const out = [];
	for (const [k, v] of Object.entries(filter ?? {})) {
		if (k === '_and' || k === '_or') { for (const c of Array.isArray(v) ? v : []) out.push(...filterFields(c)); continue; }
		if (!k.startsWith('_')) out.push(k);
	}
	return out;
}
const has = (fields, f) => BUILTIN_FIELDS.includes(f) || f in fields;

/**
 * A view's display, resolved: the collection's display with the view's merged over it sub-block by
 * sub-block — a sub-block the view omits is the collection's, and a key the view sets wins. `nav` is
 * the exception: a view with no `nav` has no nav entry, so the collection's is not inherited.
 */
export function viewDisplay(collectionDisplay, view) {
	const own = isMap(view?.display) ? view.display : {};
	const base = isMap(collectionDisplay) ? collectionDisplay : {};
	const out = {};
	for (const b of Object.keys(VIEW_DISPLAY)) {
		if (b === 'nav' && !own.nav) continue;
		const v = { ...(base[b] ?? {}), ...(own[b] ?? {}) };
		if (Object.keys(v).length) out[b] = structuredClone(v);
	}
	return out;
}
