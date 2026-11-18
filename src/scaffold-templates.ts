// The text `dt add modules` writes beside a new module's package.json (cr-dt-007, G4): a README with the
// install line, and — under `--extension` — an extension entry whose one setup unit asks for one token and
// lets the engine write it into .env (the env action, D61). Pure: strings in, strings out.

/** `acme-crm` → `ACME_CRM_TOKEN`: the one env key the scaffolded unit declares. */
export const scaffoldKey = (id) => `${id.toUpperCase().replace(/-/g, '_')}_TOKEN`;

export function readmeText({ id, pkgName, description, extension }) {
	const key = scaffoldKey(id);
	return [
		`# ${pkgName}`,
		'',
		description || 'A dreamteamer module.',
		'',
		'```bash',
		`dt install ${pkgName}`,
		...(extension ? [`dt setup ${id} --input token=<token>   # writes ${key} into .env`] : []),
		'```',
		'',
		'## Developing it',
		'',
		'```bash',
		'dt compile && dt status                  # the inline module is live in this workspace',
		'npm test                                 # node --test on dreamteamer/testing',
		`dt check modules/${id} --alone            # exit 0: publishable`,
		'```',
		'',
		'Writing a module: the `using-dreamteamer` skill, references/writing-a-module.md.',
		'',
	].join('\n');
}

export function extensionText({ id }) {
	const key = scaffoldKey(id);
	return `// ${id} — the extension entry. \`activate(dt)\` receives the running engine's API; it returns what this
// module contributes. The one setup unit asks for a token and names the .env write; the engine performs
// it (confined, fingerprint-checked, never printed). Add commands, check, doctor or next as you need them.
const KEY = '${key}';

/** Read-only and synchronous: what is set up, from the environment the engine hands over. */
function inspect(ctx) {
	return { checks: [{ id: '${id}.token', status: ctx.env[KEY] ? 'configured' : 'missing', title: KEY, fix: 'dt setup ${id} --input token=<token>' }] };
}

/** What would run: one env action, ready once the token is known. */
function plan(ctx, inputs) {
	const token = inputs.token ?? ctx.env[KEY];
	return {
		checks: inspect({ ...ctx, env: { ...ctx.env, ...(token ? { [KEY]: token } : {}) } }).checks,
		actions: [{ id: 'set-token', title: \`write \${KEY} into .env\`, env: { [KEY]: token }, state: token ? 'ready' : 'needs-input' }],
		needs: token ? [] : ['token'],
	};
}

export const apiVersion = 1;

export default function activate(dt) {
	return {
		setup: [{
			id: '${id}', version: 1,
			inputs: [{ id: 'token', kind: 'string', env: KEY, required: true, title: '${id} token', prompt: 'The token for ${id}' }],
			inspect, plan,
		}],
	};
}
`;
}

/** The one test a new module starts with: installed the way a stranger installs it, on the engine that
 *  runs the test, and checked. `npm test` runs it (`node --test`). */
export function testText({ id }) {
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
`;
}
