// held-out cr-dt-006-he7 — in a TTY the rows input's prompt shows the declared default and Enter accepts
// it; EOF at a prompt is no answer; a TTY stdout with a non-TTY stdin never prompts. rnd/tests/cr-dt-006-he7.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initialized, setupPackage, installPackage, applyLog, folder, dt, pty, cleanup } from './held-out-cr-dt-006-lib.js';

after(cleanup);

test('he7: Enter takes the rows default; EOF at the label prompt is no answer (exit 3, pending with its command); piped stdin never prompts', () => {
	const root = initialized({ name: 'he7' });
	installPackage(root, setupPackage({ name: '@heldout/probe', unit: 'probe', vars: ['PROBE_HOME'], inputs: [
		{ id: 'home', kind: 'path', env: 'PROBE_HOME', required: true, default: '~/.cache/probe', title: 'probe home', prompt: 'Where should probe keep its files?' },
		{ id: 'label', kind: 'string', required: true, title: 'label', prompt: 'A label for this workspace' },
		{ id: 'rows', kind: 'rows', title: 'rows', prompt: 'Rows (name|value)', default: 'x|1', rows: { columns: ['name', 'value'] } },
	] }));
	assert.equal(dt(root, ['compile']).code, 0);
	const home = path.join(folder('h'), 'home');
	// 1. the rows prompt shows the default; Enter accepts it; make-home applies
	const one = pty(root, ['setup', 'probe', '--input', `home=${home}`, '--input', 'label=demo'], { answers: [{ when: 'Rows (name|value)', send: '\n' }] });
	assert.equal(one.code, 0, one.out + one.err);
	const promptLine = one.out.split('\n').find((l) => l.includes('Rows (name|value)')) ?? '';
	assert.match(promptLine, /\[x\|1\]/, `the prompt shows the declared default: ${one.out}`);
	const log = applyLog(root, 'probe');
	assert.equal(log.length, 1, `make-home applied once: ${one.out}`);
	assert.deepEqual(log[0].inputs.rows, ['x|1'], 'Enter yields the default row');
	assert.deepEqual(log[0].inputs.rows[0].split('|'), ['x', '1']);
	assert.ok(fs.existsSync(home));
	const envBefore = fs.readFileSync(path.join(root, '.env'), 'utf8');
	// 2. EOF at the first prompt (label, required): no answer, pending with the exact command, exit 3, nothing written
	const home2 = path.join(folder('h2'), 'home');
	const two = pty(root, ['setup', 'probe', '--input', `home=${home2}`], { answers: [{ when: 'A label for this workspace', send: 'EOF' }] });
	assert.equal(two.code, 3, `EOF at a required prompt is exit 3: exit ${two.code}\n${two.out}${two.err}`);
	assert.match(two.out, /needs input: label/, two.out);
	assert.match(two.out, /… make-home \(needs input\)/, 'the action is printed as pending');
	assert.equal(applyLog(root, 'probe').length, 1, 'nothing was applied');
	assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), envBefore, 'nothing written');
	assert.ok(!fs.existsSync(home2), 'the folder was not made');
	// 3. a TTY stdout with a non-TTY stdin never prompts
	const three = pty(root, ['setup', 'probe', '--input', `home=${home2}`], { stdinPipe: true });
	assert.equal(three.code, 3, three.out + three.err);
	assert.doesNotMatch(three.out, /A label for this workspace/, 'no prompt without a TTY stdin');
	assert.match(three.out, /needs input: label/);
});
