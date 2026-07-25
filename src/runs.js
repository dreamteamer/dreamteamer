// run creation — the ONE code path that turns a workflow + items into a validated
// workflow-runs record (used by `workflows run`, trigger sync, and the server).
// execution stays with the attended executor per the run-state contract.
export function createRun(store, wfId, items, extra = {}) {
	const wf = store.read('workflows', wfId).fields;
	const steps = {};
	for (const [i, step] of (wf.steps ?? []).entries()) {
		steps[step.id] = i === 0 ? { status: 'running', started: new Date().toISOString().slice(0, 19) + 'Z' } : { status: 'pending' };
	}
	const fields = {
		workflow: `workflows/${wfId}`,
		items,
		status: 'running',
		'current-step': wf.steps?.[0]?.id ?? null,
		steps,
		...extra,
	};
	return store.add('workflow-runs', fields);
}
