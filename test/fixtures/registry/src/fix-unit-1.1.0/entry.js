// @fix/unit 1.1.0 — the same unit no longer needs a calendar.
function inspect() { return { checks: [{ id: 'unit.calendar', status: 'configured', title: 'calendar', detail: 'unit 1.1.0 needs nothing' }] }; }
function plan() { return { checks: inspect().checks, actions: [], needs: [] }; }
export const apiVersion = 1;
export default () => ({ setup: [{ id: 'unit', version: 1, inputs: [{ id: 'calendar', kind: 'string', title: 'calendar', prompt: 'A calendar' }], inspect, plan }] });
