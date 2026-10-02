// A UTC author date from git reads as the offset spelling a record's `created` always carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitDateToStamp } from '../../src/store.js';

test('a trailing Z becomes +00:00; an offset-spelled date is untouched', () => {
	assert.equal(gitDateToStamp('2026-10-02T12:43:40Z'), '2026-10-02T12:43:40+00:00');
	assert.equal(gitDateToStamp('2026-10-02T15:43:40+03:00'), '2026-10-02T15:43:40+03:00');
	assert.equal(gitDateToStamp('2026-10-02T07:43:40-05:00'), '2026-10-02T07:43:40-05:00');
});
