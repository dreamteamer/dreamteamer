// temporal values — the `format: date` and `format: date-time` fields — normalized on WRITE and
// compared as INSTANTS, never as strings.
//
// Two decisions live here, and they are a pair:
//
// 1. A date-time keeps its LOCAL OFFSET (`2026-07-28T12:00:00+03:00`), it is not folded to Z.
//    These records are markdown files a human reads and reviews in a git diff. A meeting at noon
//    must say 12:00 in the file, not 09:00 with the reader expected to do timezone arithmetic in
//    their head. The offset is what makes that wall-clock reading unambiguous rather than merely
//    convenient — the value still denotes exactly one instant.
//
// 2. Because (1) means two correct values can carry different offsets, ordering CANNOT be a string
//    compare. `compareValues` parses both sides to epoch ms first. Everything that orders records
//    — `_lt`/`_gt`/`_lte`/`_gte`/`_between` in filter.js and the `?sort=` in server.js and the
//    extension's api.ts — goes through it. Sorting temporals lexicographically is exactly the bug
//    (1) would otherwise have introduced: `…T12:00:00+03:00` sorts after `…T11:00:00+01:00`
//    (an EARLIER instant) on every naive comparison.
//
// The write-side normalizer is why the strictness is bearable: ajv's `date-time` accepts one
// spelling, but humans type `2026-07-28 12:00` and `<input type="datetime-local">` emits
// `2026-07-28T12:00`. Both become the canonical form before validation, so the CLI and the studio
// accept the same input — the engine/UI parity test applied to a data format.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3})\d*)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** `+03:00` for the machine's local offset AT that wall clock — DST-correct, unlike a bare "now" offset. */
function localOffsetAt(y, mo, d, h, mi, s) {
	const mins = -new Date(y, mo - 1, d, h, mi, s).getTimezoneOffset();
	const sign = mins < 0 ? '-' : '+';
	const abs = Math.abs(mins);
	return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** `+0300` / `+03:00` / `z` → `+03:00` / `Z`. One spelling on disk keeps diffs quiet. */
function canonicalZone(zone) {
	if (!zone) return null;
	if (/^z$/i.test(zone)) return 'Z';
	return zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
}

/**
 * A temporal string → epoch ms, or null when the value isn't one (so callers can fall back).
 *
 * A date-only value resolves at UTC midnight, NOT local midnight: it names a calendar day, and
 * anchoring it to the machine's zone would make the same two records sort differently on two
 * laptops. A zoneless date-time is the one case that IS machine-local — that is what "no zone"
 * means, and the normalizer stamps an explicit offset on it before it ever reaches disk.
 */
export function parseTemporal(value) {
	if (typeof value !== 'string' || value === '') return null;

	const d = DATE_ONLY.exec(value);
	if (d) return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]));

	const m = DATE_TIME.exec(value);
	if (!m) return null;
	const [, y, mo, day, h, mi, s = '0', ms = '0', zone] = m;
	const z = canonicalZone(zone);
	if (!z) {
		return new Date(Number(y), Number(mo) - 1, Number(day), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, '0'))).getTime();
	}
	const t = Date.parse(`${y}-${mo}-${day}T${h}:${mi}:${s.padStart(2, '0')}.${ms.padEnd(3, '0')}${z}`);
	return Number.isNaN(t) ? null : t;
}

/**
 * Coerce one value to the canonical spelling for its declared `format`. Anything unrecognized is
 * returned untouched — ajv rejects it a moment later with a better message than we could write.
 *
 * `date-time`: seconds are filled in, the zone is canonicalized, and a MISSING zone becomes the
 * machine's local offset at that wall clock. `date`: a date-time is truncated to the calendar day
 * AS WRITTEN — the day in the value's own offset, not in UTC and not in the reader's zone, because
 * "2026-07-28T23:00+03:00" is a meeting on the 28th to everyone who cares about it.
 */
export function normalizeTemporal(value, format) {
	if (typeof value !== 'string' || value === '') return value;

	if (format === 'date') {
		const m = DATE_TIME.exec(value);
		return m ? `${m[1]}-${m[2]}-${m[3]}` : value;
	}

	if (format !== 'date-time') return value;

	const d = DATE_ONLY.exec(value);
	if (d) return `${value}T00:00:00${localOffsetAt(Number(d[1]), Number(d[2]), Number(d[3]), 0, 0, 0)}`;

	const m = DATE_TIME.exec(value);
	if (!m) return value;
	const [, y, mo, day, h, mi, s = '00', , zone] = m;
	const sec = String(s).padStart(2, '0');
	const z = canonicalZone(zone) ?? localOffsetAt(Number(y), Number(mo), Number(day), Number(h), Number(mi), Number(sec));
	return `${y}-${mo}-${day}T${h}:${mi}:${sec}${z}`;
}

/**
 * Normalize every temporal in a record IN PLACE, walking the schema (not the data) so only
 * declared date/date-time fields are touched — a plain string that happens to look like a date
 * stays exactly as the author typed it. Recurses through object properties and array items.
 */
export function normalizeRecord(schema, fields) {
	if (!schema || fields === null || typeof fields !== 'object') return fields;
	for (const [key, prop] of Object.entries(schema.properties ?? {})) {
		const value = fields[key];
		if (value === undefined || value === null) continue;
		if (prop?.format === 'date' || prop?.format === 'date-time') {
			fields[key] = normalizeTemporal(value, prop.format);
		} else if (prop?.type === 'object') {
			normalizeRecord(prop, value);
		} else if (prop?.type === 'array' && Array.isArray(value)) {
			const items = prop.items;
			if (items?.format === 'date' || items?.format === 'date-time') {
				fields[key] = value.map((v) => normalizeTemporal(v, items.format));
			} else if (items?.type === 'object') {
				for (const row of value) normalizeRecord(items, row);
			}
		}
	}
	return fields;
}

/**
 * The ordering used by every range filter and every `?sort=`. Temporals first (as instants),
 * then numbers numerically, then locale string order.
 *
 * The numeric branch deliberately excludes `''`: `Number('')` is 0, which would sort a blank field
 * as "zero" and slot it between real numbers instead of grouping the blanks together.
 */
export function compareValues(a, b) {
	const ta = parseTemporal(a);
	const tb = parseTemporal(b);
	if (ta !== null && tb !== null) return ta - tb;

	if (a !== '' && b !== '' && a != null && b != null) {
		const na = Number(a);
		const nb = Number(b);
		if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
	}
	return String(a ?? '').localeCompare(String(b ?? ''));
}

/** `?sort=field` / `?sort=-field`, ordered with `compareValues`. Mutates and returns `rows`. */
export function sortRows(rows, sort) {
	if (!sort) return rows;
	const desc = String(sort).startsWith('-');
	const key = desc ? String(sort).slice(1) : String(sort);
	return rows.sort((a, b) => compareValues(a[key] ?? '', b[key] ?? '') * (desc ? -1 : 1));
}
