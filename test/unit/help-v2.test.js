// `dt help` is the complete command surface, so a v1 key or flag left in it teaches a spelling the
// engine refuses. Each pattern is a word the descriptor format v2 removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { USAGE } from '../../src/cli.js';

const V1 = [
	/\bx-[a-z]+/, /\blist_fields\b/, /\bsort_field\b/, /\btitle_template\b/, /collection-templates?\b/, /\bcodec\b/,
	/\bextends\b/, /\bpeerDependencies\b/, /\bworkspace-module\b/, /\bgit-modules\b/, /\bowns-data\b/, /\bdata-path\b/,
	/\bcan-enter\b/, /\bcan-exit\b/, /group: system/, /--options\b/, /--inverse\b/, /--target\b/, /--template\b/,
	/--id-shape\b/, /\bdt move\b/, /^\s+move\s/m, /\bschema\.properties\b/,
];

test('dt help names no key or flag descriptor format v2 removed', () => {
	for (const re of V1) assert.doesNotMatch(USAGE, re, `help still teaches ${re}`);
});
