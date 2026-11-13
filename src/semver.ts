// tiny semver-range checker for engine-pin checks — deliberately NOT npm's semver.
// supported ranges: exact "1.2.3", "^1.2.3", "~1.2.3", ">=1.2.3", "*".
// NOT supported (returns null, "can't tell"): "||" alternatives, hyphen ranges,
// x-ranges (1.2.x), combined comparators (">=1.0.0 <2.0.0"), <, <=, >,
// prerelease/build tags. callers treat null as "warn, don't guess".

const parse = (v) => {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// true = in range, false = out of range, null = version or range not understood
export function satisfies(version, range) {
	const v = parse(version);
	if (!v) return null;
	const r = String(range).trim();
	if (r === '*') return true;
	const m = /^(>=|\^|~)?(\d+\.\d+\.\d+)$/.exec(r);
	if (!m) return null;
	const base = parse(m[2]);
	switch (m[1]) {
		case '>=': return cmp(v, base) >= 0;
		case '^': // same major, >= base; zero-major pins the minor too (npm's ^0.x rule)
			if (cmp(v, base) < 0) return false;
			return base[0] === 0 ? v[0] === 0 && v[1] === base[1] : v[0] === base[0];
		case '~': // same major.minor, >= base
			return cmp(v, base) >= 0 && v[0] === base[0] && v[1] === base[1];
		default: return cmp(v, base) === 0; // exact
	}
}
