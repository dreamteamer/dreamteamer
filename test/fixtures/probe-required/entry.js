// A unit with one REQUIRED secret-path input: the shape that makes an invalid environment value visible.
export const apiVersion = 1;
export default function activate() {
	return { setup: [{
		id: 'probereq', version: 1,
		inputs: [{ id: 'token', kind: 'secret-path', env: 'PROBEREQ_TOKEN_PATH', required: true, title: 'token file', prompt: 'Path to the token file (never read)' }],
		inspect: (ctx) => ({ checks: [{ id: 'probereq.token', status: ctx.env?.PROBEREQ_TOKEN_PATH ? 'configured' : 'missing', title: 'token file', detail: ctx.env?.PROBEREQ_TOKEN_PATH ? 'set' : 'unset' }] }),
		plan: (ctx, inputs = {}) => ({ checks: [], actions: [], needs: inputs.token ? [] : ['token'] }),
		apply: () => ({ ok: true, changed: [] }),
	}] };
}
