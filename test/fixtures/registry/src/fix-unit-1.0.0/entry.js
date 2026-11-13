// @fix/unit 1.0.0 — its unit asks for a calendar it cannot do without.
function inspect() { return { checks: [{ id: 'unit.calendar', status: 'missing', title: 'calendar', detail: 'unit 1.0.0 needs a calendar' }] }; }
function plan(ctx, inputs) { return { checks: inspect().checks, actions: [], needs: inputs.calendar ? [] : ['calendar'] }; }
export const apiVersion = 1;
export default () => ({ setup: [{ id: 'unit', version: 1, inputs: [{ id: 'calendar', kind: 'string', title: 'calendar', prompt: 'A calendar' }], inspect, plan }] });
