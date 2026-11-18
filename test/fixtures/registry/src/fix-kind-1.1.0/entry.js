// @fix/kind 1.1.0 — the same extension now contributes the source kind `gizmos` and ships one entry of it
// (dt update compiles with the version npm just installed).
export const apiVersion = 1
export default () => ({ sourceKinds: ["gizmos"] })
