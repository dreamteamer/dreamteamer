// record filtering — the operator set harvested from the hq2 engine's
// query/compare.ts (Directus-style), trimmed to what the studio FilterBuilder
// and saved views actually emit. evaluated server-side over parsed records.
// negative operators deliberately reject null (SQL semantics, as in hq2).

export function matchesFilter(record, filter) {
	if (filter == null || typeof filter !== 'object') return true;
	for (const [key, cond] of Object.entries(filter)) {
		if (key === '_and') { if (!cond.every((c) => matchesFilter(record, c))) return false; continue; }
		if (key === '_or') { if (!cond.some((c) => matchesFilter(record, c))) return false; continue; }
		if (!matchesField(record[key], cond)) return false;
	}
	return true;
}

function matchesField(value, cond) {
	if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return compare('_eq', value, cond);
	for (const [op, operand] of Object.entries(cond)) {
		if (!compare(op, value, operand)) return false;
	}
	return true;
}

function compare(op, v, o) {
	const s = (x) => String(x ?? '');
	const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
	// array field values (tags, attendees): containment semantics for eq/contains
	const arr = Array.isArray(v);
	switch (op) {
		case '_eq': return arr ? v.includes(o) : looseEq(v, o);
		case '_neq': return v != null && !(arr ? v.includes(o) : looseEq(v, o));
		case '_ieq': return s(v).toLowerCase() === s(o).toLowerCase();
		case '_nieq': return v != null && s(v).toLowerCase() !== s(o).toLowerCase();
		case '_lt': return v != null && cmp(v, o) < 0;
		case '_lte': return v != null && cmp(v, o) <= 0;
		case '_gt': return v != null && cmp(v, o) > 0;
		case '_gte': return v != null && cmp(v, o) >= 0;
		case '_in': return toArray(o).some((x) => (arr ? v.includes(x) : looseEq(v, x)));
		case '_nin': return v != null && !toArray(o).some((x) => (arr ? v.includes(x) : looseEq(v, x)));
		case '_null': return o ? v == null : v != null;
		case '_nnull': return o ? v != null : v == null;
		case '_empty': return o ? empty : !empty;
		case '_nempty': return o ? !empty : empty;
		case '_contains': return arr ? v.some((x) => s(x).includes(s(o))) : s(v).includes(s(o));
		case '_ncontains': return v != null && !s(v).includes(s(o));
		case '_icontains': return arr ? v.some((x) => s(x).toLowerCase().includes(s(o).toLowerCase())) : s(v).toLowerCase().includes(s(o).toLowerCase());
		case '_starts_with': return s(v).startsWith(s(o));
		case '_istarts_with': return s(v).toLowerCase().startsWith(s(o).toLowerCase());
		case '_ends_with': return s(v).endsWith(s(o));
		case '_iends_with': return s(v).toLowerCase().endsWith(s(o).toLowerCase());
		case '_between': { const [a, b] = toArray(o); return v != null && cmp(v, a) >= 0 && cmp(v, b) <= 0; }
		case '_nbetween': { const [a, b] = toArray(o); return v != null && (cmp(v, a) < 0 || cmp(v, b) > 0); }
		case '_regex': try { return new RegExp(String(o)).test(s(v)); } catch { return false; }
		default:
			// unknown operator NARROWS, never widens (review finding 5): filters are load-bearing
			// in compiled ui-views — a typo'd _nq matching everything showed every user's tasks
			// with no signal. warn once per operator per process.
			warnUnknownOp(op);
			return false;
	}
}

export const KNOWN_OPERATORS = new Set(['_eq', '_neq', '_ieq', '_nieq', '_lt', '_lte', '_gt', '_gte', '_in', '_nin', '_null', '_nnull', '_empty', '_nempty', '_contains', '_ncontains', '_icontains', '_starts_with', '_istarts_with', '_ends_with', '_iends_with', '_between', '_nbetween', '_regex', '_and', '_or']);

const warned = new Set();
function warnUnknownOp(op) {
	if (warned.has(op)) return;
	warned.add(op);
	console.warn(`⚠ unknown filter operator "${op}" — treated as matching NOTHING (known: ${[...KNOWN_OPERATORS].join(', ')})`);
}

// walk a filter tree and return every operator key not in the known set — compile
// validates ui-view filters with this so a typo'd operator fails loudly at compile time.
export function unknownOperators(filter, found = new Set()) {
	if (filter == null || typeof filter !== 'object') return found;
	for (const [key, cond] of Object.entries(filter)) {
		if (key === '_and' || key === '_or') {
			for (const c of Array.isArray(cond) ? cond : []) unknownOperators(c, found);
		} else if (key.startsWith('_')) {
			if (!KNOWN_OPERATORS.has(key)) found.add(key);
		} else if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
			for (const op of Object.keys(cond)) {
				if (op.startsWith('_') && !KNOWN_OPERATORS.has(op)) found.add(op);
			}
		}
	}
	return found;
}

const looseEq = (v, o) => v === o || String(v) === String(o) || (typeof v === 'number' && Number(o) === v);
const toArray = (o) => (Array.isArray(o) ? o : String(o).split(',').map((x) => x.trim()));
function cmp(a, b) {
	const na = Number(a);
	const nb = Number(b);
	if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
	return String(a).localeCompare(String(b));
}
