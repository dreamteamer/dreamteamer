// id-template evaluation per the descriptor `id.generate` contract:
// {{ field | filter[:arg] | ... }} — vocabulary: record fields, created/now,
// seq (next free sequence for the rendered prefix), filters date[:fmt],
// datetime, slug, pad:n, basename. dates come from CREATION time, never
// mutable fields.
const SEQ = '__DT_SEQ__';

/** Render ONE template, or throw if a field it names is missing. The list form loops over this. */
export function generateId(tpl, fields, existingIds = [], opts = {}) {
	// ⚠ AN ORDERED LIST IS "USE THIS, ELSE THAT" — the only way a descriptor can express a readable
	// latin handle WITHOUT forcing a required field onto every record. `id.generate` takes a string
	// or a list of them, and the FIRST template whose fields are all present wins; a template that
	// names a missing field is skipped, not fatal, until the last one, whose error is the one the
	// writer sees. Before this, a missing field threw before any fallback could run and an unknown
	// `default` filter threw too, so `{{ code }} else {{ name | slug }}` was inexpressible and the
	// only workaround was passing --id on every single add.
	if (Array.isArray(tpl)) {
		for (let i = 0; i < tpl.length; i++) {
			try { return generateId(tpl[i], fields, existingIds, opts); }
			catch (e) { if (i === tpl.length - 1) throw e; }
		}
	}
	const created = new Date();
	let sawSeq = false;
	let seqPad = 0;

	const rendered = tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
		const [head, ...filters] = expr.split('|').map((s) => s.trim());
		let value;
		if (head === 'created' || head === 'now') value = created;
		else if (head === 'seq') { sawSeq = true; value = SEQ; }
		else value = fields[head];
		if (value === undefined || value === null || value === '') {
			throw new Error(`id template needs "${head}" — provide it (or pass an explicit id)`);
		}
		for (const f of filters) {
			const [name, arg] = f.split(':').map((s) => s.trim());
			if (value === SEQ) {
				if (name === 'pad') seqPad = Number(arg) || 0;
				continue; // filters never transform the seq placeholder itself
			}
			value = applyFilter(name, arg, value, { field: head, onFallback: opts.onFallback });
		}
		if (value instanceof Date) value = fmtDate(value, 'YYYY-MM-DD');
		return String(value);
	});

	if (!sawSeq) return rendered;

	// seq: next free number among existing ids matching the rendered prefix/suffix
	const [prefix, suffix] = rendered.split(SEQ);
	let max = 0;
	for (const id of existingIds) {
		if (!id.startsWith(prefix) || !id.endsWith(suffix)) continue;
		const mid = id.slice(prefix.length, suffix.length ? -suffix.length : undefined);
		if (/^\d+$/.test(mid)) max = Math.max(max, Number(mid));
	}
	const n = String(max + 1);
	return prefix + (seqPad ? n.padStart(seqPad, '0') : n) + suffix;
}

function applyFilter(name, arg, value, ctx = {}) {
	switch (name) {
		case 'date': return fmtDate(asDate(value), arg || 'YYYY-MM-DD');
		// ids are paths: no colons (windows-hostile, ungreppable) — 2026-07-25T13-39-17
		case 'datetime': return asDate(value).toISOString().slice(0, 19).replace(/:/g, '-');
		// ⚠ THE SILENCE IS THE DEFECT, NOT THE ERGONOMICS. A value with no a-z0-9 in it — any Hebrew,
		// Arabic, Cyrillic or CJK name — has nothing to slug, so this falls back to a deterministic
		// hash and THE WRITE SUCCEEDS. That is worse than a refusal: `x1a2b3c4` lands, passes
		// `check`, gets referenced by other records, and is discovered only when a person reads the
		// tree, by which point renaming it is a migration. The fallback still happens (an id must be
		// produced, and existing records keep theirs), but it is no longer silent: the caller is
		// handed the field, the value and the id so a writer can say so.
		case 'slug': {
			const out = slugOrHash(String(value));
			if (ctx.onFallback && out !== slug(String(value))) {
				ctx.onFallback({ field: ctx.field, value: String(value), id: out });
			}
			return out;
		}
		case 'pad': return String(value).padStart(Number(arg) || 0, '0');
		case 'basename': return String(value).split('/').pop();
		default: throw new Error(`unknown id-template filter "${name}"`);
	}
}

const asDate = (v) => (v instanceof Date ? v : new Date(v));

// `date:HH-mm` on a date-time field is how an id embeds a start time (data/meetings ids sort by
// start within a day). Tokens are replaced longest-first so `MM` (month) can't eat the `M` of a
// minute pattern. Everything is read in the MACHINE's zone — an offset-carrying value like
// `2026-07-28T12:00:00+03:00` therefore renders as 12:00 only on a +03:00 machine. That is the
// same exposure the old `date` field had and is why ids are generated at sync time, in the zone
// the meetings actually happen in, rather than re-derived later somewhere else.
function fmtDate(d, fmt) {
	const pad = (n, w = 2) => String(n).padStart(w, '0');
	const tokens = {
		YYYY: String(d.getFullYear()),
		MM: pad(d.getMonth() + 1),
		DD: pad(d.getDate()),
		HH: pad(d.getHours()),
		mm: pad(d.getMinutes()),
		ss: pad(d.getSeconds()),
	};
	return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => tokens[t]);
}

export function slug(s) {
	return s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

// non-latin titles (hebrew!) slug to "" — fall back to a short deterministic
// hash of the original value so the id stays pattern-legal and stable
export function slugOrHash(s) {
	const out = slug(s);
	if (out) return out;
	let h = 0;
	for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
	return 'x' + h.toString(36).padStart(7, '0');
}
