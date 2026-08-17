// The reporter, because output volume is a feature of a test suite and not a detail.
//
// A green run must be readable in one glance and cost almost nothing to scroll past; a red run must
// print everything needed to fix it WITHOUT a second, more verbose run. Node's built-in reporters sit
// on either side of that: `spec` prints a paragraph per passing test, `dot` prints dots and then no
// summary at all, so "did it pass?" becomes a question about the exit code.
//
// This is ~40 lines and has no dependencies. It yields a dot per test, then one summary line, then
// the full detail of each failure — file, test name, assertion diff.
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

export default async function* reporter(source) {
	let passed = 0;
	let skipped = 0;
	const failures = [];
	let started;

	for await (const event of source) {
		// `describe` blocks emit pass/fail events too; counting them would inflate the numbers and,
		// worse, report a suite-level failure as a second unexplained failure beside the real one.
		const isSuite = event.data?.details?.type === 'suite';
		switch (event.type) {
			case 'test:start':
				started ??= Date.now();
				break;
			case 'test:pass':
				if (isSuite) break;
				if (event.data.skip || event.data.todo) { skipped++; yield `${DIM}-${OFF}`; break; }
				passed++;
				yield `${GREEN}.${OFF}`;
				break;
			case 'test:fail':
				if (isSuite) break;
				failures.push(event.data);
				yield `${RED}F${OFF}`;
				break;
			case 'test:stderr':
			case 'test:stdout':
				// a console.log from inside a test would otherwise land mid-dot-row
				yield `\n${event.data.message}`;
				break;
		}
	}

	const ms = started ? Date.now() - started : 0;
	const total = passed + failures.length + skipped;
	yield '\n\n';

	for (const f of failures) {
		const err = f.details?.error;
		const cause = err?.cause ?? err;
		yield `${RED}✖ ${f.name}${OFF}\n`;
		yield `${DIM}  ${f.file ?? ''}${f.line ? `:${f.line}` : ''}${OFF}\n`;
		const message = cause?.message ?? String(cause ?? 'unknown failure');
		yield `${message.split('\n').map((l) => `  ${l}`).join('\n')}\n`;
		// An assertion failure carries the two values; a thrown Error carries a stack instead. The
		// typeof guard is load-bearing: node:test sometimes reports a bare STRING cause ("test failed",
		// e.g. when a file fails to load at all), and `'expected' in aString` throws — which crashed the
		// reporter and hid the real failure behind a TypeError from the reporter itself.
		if (cause && typeof cause === 'object' && 'expected' in cause && !message.includes('expected')) {
			yield `${DIM}  expected: ${JSON.stringify(cause.expected)}\n  actual:   ${JSON.stringify(cause.actual)}${OFF}\n`;
		}
		yield '\n';
	}

	const head = failures.length ? `${RED}✖ ${failures.length} failed${OFF}` : `${GREEN}✔ all passed${OFF}`;
	yield `${head}  ${DIM}${passed}/${total} passed`
		+ `${skipped ? `, ${skipped} skipped` : ''} in ${(ms / 1000).toFixed(1)}s${OFF}\n`;
}
