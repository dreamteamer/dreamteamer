// A CONSUMER of the published declarations, type-checked under `strict` by
// test/integration/public-api.test.js against the GENERATED dist/*.d.ts. It is the contract's test now
// that the declarations come from the source: every line below is something the editor, the mobile app
// or an extension relies on, and every `@ts-expect-error` is a promise that a signature is NOT `any` —
// if one loosens, the expected error disappears and the unused directive fails the compile.
import * as dt from 'dreamteamer';
import * as records from 'dreamteamer/records';
import type { Descriptor, Fields, Workspace, LoadedExtension, Presentation, Storage, Manifest, Contribution, Activate } from 'dreamteamer';

type IsAny<T> = 0 extends 1 & T ? true : false;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const is = <T extends true>() => {};

// ---- PRECISION RATCHET: no public function takes or returns `any`, except the names listed — each
// one typed loosely by the contract itself. Shrink the list; never grow it without a reason.
type Fn = (...a: any[]) => any;
type LooseFn<F> = F extends Fn ? (IsAny<ReturnType<F>> extends true ? true : true extends { [K in keyof Parameters<F>]: IsAny<Parameters<F>[K]> }[number] ? true : false) : false;
type Loose<M> = { [K in keyof M]: LooseFn<M[K]> extends true ? K : never }[keyof M];
type SchemaOps = 'createCollection' | 'removeCollection' | 'renameCollection' | 'moveCollection' | 'setCollectionScalars'
	| 'addField' | 'updateField' | 'removeField' | 'removeFieldPlan' | 'renameField' | 'renameFieldPlan' | 'renameValue' | 'renameValuePlan'
	| 'saveUiView' | 'removeUiView' | 'moveUiView' | 'createModule' | 'setModule' | 'renameModule' | 'removeModule'
	| 'createSkill' | 'refuseHandAuthored' | 'removeEntity' | 'renameEntity' | 'setEntityFrontmatter';
type AllowedLoose = SchemaOps | 'loadYaml' | 'distinctValues';
is<Equals<Exclude<Loose<typeof dt>, AllowedLoose>, never>>();
is<Equals<Exclude<Loose<typeof records>, AllowedLoose>, never>>();
type StoreMethods = 'descriptor' | 'dir' | 'recordDirs' | 'ids' | 'external' | 'read' | 'locate' | 'readAll' | 'createdOf' | 'addedDates'
	| 'add' | 'addFile' | 'set' | 'rm' | 'rename' | 'revert' | 'relocatePlan' | 'relocate' | 'findInboundRefs';
is<Equals<Loose<Pick<dt.Store, StoreMethods>>, never>>();

// ---- the values and their kinds (F8: a declared array that is a Set at run time) ------------------
is<Equals<typeof dt.apiVersion, 1>>();
is<Equals<typeof dt.EXTENSION_API, 1>>();
is<Equals<typeof dt.CHECK_WARNINGS, true>>();
is<Equals<typeof dt.RUNTIME_DIR, '.dreamteamer'>>();
const ops: ReadonlySet<string> = dt.KNOWN_OPERATORS;
// @ts-expect-error — a Set, not an array
dt.KNOWN_OPERATORS.includes('_eq');
const kinds: readonly string[] = dt.KINDS;
// @ts-expect-error — readonly
dt.KINDS.push('x');

// ---- the workspace and the Store ---------------------------------------------------------------
async function surface() {
	const ws = await dt.openWorkspace('/w');
	is<Equals<typeof ws, Workspace & { extensions: LoadedExtension[] }>>();
	const ext: LoadedExtension = ws.extensions[0];
	const name: string = ext.name;
	const store = new dt.Store(ws);
	// @ts-expect-error — a workspace handle, not a path
	new dt.Store('/w');
	const d: Descriptor = store.descriptor('notes');
	const r = store.read('notes', 'a');
	is<Equals<typeof r, { fields: Fields; file: string }>>();
	// @ts-expect-error — ids are strings
	store.read('notes', 1);
	const ids: Map<string, string> = store.ids('notes');
	const added = store.add('notes', { title: 'x' }, { id: 'x' });
	const id: string = added.id;
	const where: { file: string; repo: string | null } = store.locate('notes', 'a');
	const outside = store.external('notes', 'a', { referrer: 'meetings/x' });
	is<Equals<typeof outside, { label: string; from?: string; manifest: string } | null>>();
	for (const row of store.readAll('notes')) { const f: Fields = row.fields; }
	const removed: number = store.rm('notes', 'a').inboundIgnored;
	const plan = store.relocatePlan('notes');
	const why: 'placement' | 'shape' = plan.moves[0].why;

	const s: Storage = dt.storageOf(d);
	const root: string = s.roots[0].path;
	const fmt: 'md' | 'yaml' | 'json' | 'binary' = s.format;
	const m: Manifest | null = dt.readManifest('/w');
	const p: Presentation = dt.presentation(store.descriptors);
	const title: string = p.collections[0].title;
	const ref = dt.parseRef('notes/a', []);
	// @ts-expect-error — null when nothing parses
	ref.collection;
	const verdict: 0 | 1 | 2 = dt.check(ws);
	const commits = dt.commitPending(store, { dryRun: true });
	const sha: string | null | undefined = commits[0].sha; // null on a dry run
	const code: number = await dt.installCommand(ws, ['install']);
	const sorted: { id: string }[] = dt.sortRows([{ id: 'a' }], '-id');
	const resolver: (ref: string) => Fields | null = dt.recordResolver(store);
	const t: dt.TemplatePart[] = dt.parseTemplate('{{ name }}');
	const bin: string = dt.engineBin;
}

// ---- the extension contract -------------------------------------------------------------------
const activate: Activate = (api) => {
	const v: 1 = api.apiVersion;
	const c: Contribution = {
		commands: { hello: { usage: 'dt hello', run: (ws, argv) => (argv.length ? 0 : 1) } },
		check: ({ ws }) => [{ message: `checked ${ws.root}` }],
		doctor: () => [{ label: 'ok', state: 'ok' }],
	};
	return c;
};
// @ts-expect-error — a doctor row's state is one of three
const bad: Contribution = { doctor: () => [{ label: 'x', state: 'fine' }] };

export { surface, activate, bad, ops, kinds };
