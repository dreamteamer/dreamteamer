// The one surface every adapter shares.
export * from './types.ts';
export { discover } from './discover.ts';
export { buildModel, findCollection, splitRef } from './model.ts';
export { listIds, list, get, add, set, rm, referrers, check, validate, stamp } from './store.ts';
export { compile, instructions } from './compile.ts';
