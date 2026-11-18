/**
 * The one test a new module starts with: installed the way a stranger installs it, on the engine that
 * runs the test, and checked. `npm test` runs it (`node --test`).
 */
export function testText({ id }: { id: string }): string {
  return `// ${id} — installed into a fresh workspace on the engine running this test, the way a stranger installs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createWorkspace, install, run } from 'dreamteamer/testing';

test('${id} installs into a fresh workspace and checks clean', () => {
	const ws = createWorkspace();
	const r = install(ws, fileURLToPath(new URL('..', import.meta.url)));   // packed with npm pack, then dt install
	assert.ok([0, 3].includes(r.status), r.stdout + r.stderr);               // 3: an input is still to be given
	assert.equal(run(ws, ['check']).status, 0);
});
`
}
