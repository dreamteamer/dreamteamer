// a unit whose one input is required: dt install exits 3 until it is given — still publishable
export const apiVersion = 1;
const inspect = (ctx) => ({ checks: [{ id: 'alone.token', status: ctx.env.ALONE_TOKEN ? 'configured' : 'missing', title: 'ALONE_TOKEN', fix: 'dt setup alone --input token=<token>' }] });
const plan = (ctx, inputs) => ({ checks: inspect(ctx).checks, actions: [{ id: 'set-token', title: 'write ALONE_TOKEN into .env', env: { ALONE_TOKEN: inputs.token }, state: inputs.token ? 'ready' : 'needs-input' }], needs: inputs.token ? [] : ['token'] });
export default function activate() {
	return { setup: [{ id: 'alone', version: 1, inputs: [{ id: 'token', kind: 'string', env: 'ALONE_TOKEN', required: true }], inspect, plan }] };
}
