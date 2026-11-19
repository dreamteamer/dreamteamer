import { scaffoldKey } from "./scaffoldKey.ts"

export function extensionText({ id }: { id: string }): string {
  const key = scaffoldKey(id)
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
`
}
