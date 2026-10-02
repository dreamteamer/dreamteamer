// Accessors over a COMPILED descriptor — the one way any reader asks what a collection is.
//
// A compiled descriptor is the authored v2 keys plus the `compiled` block compile wrote: `defaults`
// (what compile supplied because the author did not), `module`, `repo`, `runtime`, `under_collection`,
// `mirrors`, `overlaid_by`, `unresolved_peers`, `fields` (resolved) and `json_schema` (the validator's).
// A reader never looks at the authored keys and the defaults separately, and never re-derives a fact
// compile already decided: it asks here. Pure — no fs, no git, no knowledge of modules.
import { SCALAR_TYPES } from './fields.js';

const block = (d) => d?.compiled ?? {};
const defaults = (d) => block(d).defaults ?? {};

/** The resolved fields, injected ones included, in form order. */
export const fieldsOf = (d) => block(d).fields ?? {};
/** The fields a record STORES — everything but the virtual ones (`id`, `last_modified`). */
export const storedFieldsOf = (d) => Object.fromEntries(Object.entries(fieldsOf(d)).filter(([, f]) => !f.virtual));
/** The JSON Schema the validator runs. Standard keywords only. */
export const jsonSchemaOf = (d) => block(d).json_schema ?? { type: 'object', properties: {} };
/** The field a record's prose lands in — the text after the frontmatter — or undefined. */
export const bodyFieldOf = (d) => Object.entries(fieldsOf(d)).find(([, f]) => f.body)?.[0];
/** The one `type: position` field — what `dt reorder` writes — or undefined. */
export const positionFieldOf = (d) => Object.entries(fieldsOf(d)).find(([, f]) => f.type === 'position')?.[0];
/** The names of the required fields. */
export const requiredOf = (d) => Object.entries(fieldsOf(d)).filter(([, f]) => f.required).map(([k]) => k);

/**
 * What a field references: `null` (not a reference), `'*'` (any record — `type: reference`), or the
 * list of collections it may target (`type: <collection>` or a union `[a, b]`).
 */
export function targetsOf(field) {
	const t = field?.type;
	if (Array.isArray(t)) return t;
	if (t === 'reference') return '*';
	if (typeof t === 'string' && !SCALAR_TYPES.includes(t)) return [t];
	return null;
}
/** A soft reference: the value must target a named collection, but a missing record is tolerated. */
export const isSoft = (field) => field?.soft === true;
/** The field this one mirrors on the target collection, or undefined. */
export const mirrorOf = (field) => field?.mirror_of;

export const titleOf = (d) => d?.title ?? defaults(d).title ?? d?.name;
export const singularOf = (d) => d?.singular ?? defaults(d).singular;
export const recordTitleOf = (d) => d?.record_title ?? defaults(d).record_title ?? '{{ id }}';
/** How ids are made: `{ from, pattern }`. `from` is a template or an ordered list of them. */
export const idsOf = (d) => ({ ...(defaults(d).ids ?? {}), ...(d?.ids ?? {}) });

/** Storage, resolved: what the author wrote over what compile supplied, plus the facts compile decided. */
export function storageOf(d) {
	const a = d?.storage ?? {};
	const s = defaults(d).storage ?? {};
	const out = {
		path: a.path ?? s.path,
		format: a.format ?? s.format ?? 'md',
		shape: a.shape ?? s.shape ?? 'file',
		suffix: a.suffix ?? s.suffix,
		repo: block(d).repo ?? '.',
		runtime: block(d).runtime === true,
	};
	if (a.entry !== undefined) out.entry = a.entry;
	if (a.max_bytes !== undefined) out.max_bytes = a.max_bytes;
	if (a.accept !== undefined) out.accept = a.accept;
	if (a.under) out.under = { parent: a.under.parent, subfolder: a.under.subfolder, collection: block(d).under_collection, id: a.under.id ?? 'independent' };
	return out;
}
/** Records are build output written by compile (a system kind), not workspace data. */
export const isRuntime = (d) => block(d).runtime === true;
/** Workspace plumbing hidden from the domain listing. */
export const isInternal = (d) => d?.internal === true;
export const isSensitive = (d) => d?.sensitive === true;
/** Records are opaque files (`format: binary`): no frontmatter, fields derived from the file. */
export const isBinary = (d) => storageOf(d).format === 'binary';

/** The display block, the authored keys over the defaults compile supplied, sub-block by sub-block. */
export function displayOf(d) {
	const a = d?.display ?? {};
	const s = defaults(d).display ?? {};
	const out = {};
	for (const b of ['nav', 'list', 'record', 'form']) {
		const v = { ...(s[b] ?? {}), ...(a[b] ?? {}) };
		if (Object.keys(v).length) out[b] = v;
	}
	return out;
}

export const moduleOf = (d) => block(d).module;
export const overlaidByOf = (d) => block(d).overlaid_by ?? [];
export const unresolvedPeersOf = (d) => block(d).unresolved_peers ?? [];
/** The fields that are generated mirrors of another collection's reference. */
export const mirrorsOf = (d) => block(d).mirrors ?? [];
