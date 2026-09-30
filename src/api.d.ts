// The typed contract of `import … from 'dreamteamer'` (src/api.js). A test pins the runtime export
// list to the names declared here, so a name added to one and not the other fails the suite.
//
// Shapes the engine does not constrain (a record's fields, a descriptor's schema) are typed loosely on
// purpose: they are the workspace's, and a type here would be a second schema that drifts.

export type Fields = Record<string, unknown>;
export type Descriptor = {
	name: string;
	title?: string;
	singular?: string;
	description?: string;
	use_when?: string;
	module?: string;
	storage: { path: string; base: 'workspace' | 'runtime'; codec?: 'md' | 'yaml' | 'json' | 'file'; shape?: 'file' | 'folder'; suffix?: string; repo?: string; [k: string]: unknown };
	schema: { type?: string; required?: string[]; properties?: Record<string, any>; [k: string]: unknown };
	[k: string]: unknown;
};
export type Descriptors = Map<string, Descriptor>;
export type Manifest = { compiled: string; engine: string; namespaces: string[]; extensions?: { name: string; version: string }[]; 'source-kinds'?: { kind: string; exclude: string[]; extension: string }[]; entries: Record<string, { sources: { path: string; hash: string }[]; hash: string }>; [k: string]: unknown };

// ---- the workspace and extensions ------------------------------------------------------------------

export interface Workspace {
	/** absolute path of the workspace root */
	root: string;
	/** the workspace package.json */
	pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; dreamteamer?: Record<string, any>; [k: string]: unknown };
	/** the ACTIVATED extensions, present on a handle from `openWorkspace` */
	extensions?: LoadedExtension[];
}

/** What an extension's `activate(dt)` returns. Every key is optional. */
export interface Contribution {
	commands?: Record<string, { usage?: string; run(ws: Workspace, argv: string[]): number | void | Promise<number | void> }>;
	sourceKinds?: (string | { kind: string; exclude?: string[] })[];
	analyze?(draft: CompileDraft): { errors?: string[]; warnings?: string[]; notes?: string[] } | void;
	harnesses?: Record<string, (ctx: HarnessContext) => { blocks?: Record<string, string | null>; summary?: string } | void>;
	orientation?: string | ((ctx: { entries: Map<string, Entry> }) => string);
	hooks?: Record<string, string>;
}
export type Activate = (dt: typeof import('./api.js')) => Contribution | Promise<Contribution>;
export interface LoadedExtension {
	name: string;
	version: string;
	commands: NonNullable<Contribution['commands']>;
	sourceKinds: { kind: string; exclude: string[]; extension: string }[];
	analyze: Contribution['analyze'] | null;
	harnesses: NonNullable<Contribution['harnesses']>;
	orientation: Contribution['orientation'] | null;
	hooks: Record<string, string>;
}
export type Entry = { sources: { path: string; hash: string }[]; bytes: Buffer };
export interface CompileDraft {
	/** runtime-relative path → staged entry; read-only */
	readonly entries: Map<string, Entry>;
	/** the FINAL merged descriptors */
	readonly descriptors: Descriptors;
	readonly modules: { id: string; name: string; root: string; channel: 'inline' | 'git' | 'npm' }[];
	/** names only — never values */
	readonly declaredVars: string[];
	readonly declaredEnv: string[];
	readonly previousManifest: Manifest | null;
	/** parse one staged YAML entry, with its source path in any error */
	parse(runtimePath: string): any;
}
export interface HarnessContext {
	entries: Map<string, Entry>;
	version: string;
	collections: { name: string; generated: boolean; systemGroup: boolean; description: string; module: string; sensitive: boolean; sensitiveFields: string[] }[];
	modules: { id: string; title: string; description: string; path: string }[];
}

export const apiVersion: 1;
export const EXTENSION_API: 1;
export function openWorkspace(start?: string): Promise<Workspace & { extensions: LoadedExtension[] }>;
export function findWorkspace(start?: string): Workspace;
export function declaredExtensions(ws: Workspace): { name: string; version: string; dir: string; entry: string }[];
export const engineBin: string;
export const engineRoot: string;
export function engineVersion(): string;
export function engineId(): string;

// ---- records -------------------------------------------------------------------------------------------

export class Store {
	constructor(ws: Workspace);
	root: string;
	descriptors: Descriptors;
	descriptor(collection: string): Descriptor;
	ids(collection: string): Set<string>;
	read(collection: string, id: string): { fields: Fields; file: string };
	readAll(collection: string): Iterable<{ id: string; fields: Fields; file: string }>;
	add(collection: string, fields: Fields, opts?: { id?: string }): { id: string; file: string; idFallback?: unknown };
	addFile(collection: string, id: string, from: string, opts?: { force?: boolean }): { id: string; file: string };
	set(collection: string, id: string, changes: Fields): unknown;
	rm(collection: string, id: string, opts?: { force?: boolean }): { inboundIgnored: number };
	rename(collection: string, oldId: string, newId: string): { id: string; rewrites: number; touched: number };
	revert(collection: string, id: string, hash: string): { reverted: boolean };
	findInboundRefs(ref: string): unknown[];
	[k: string]: any;
}
export function bodyField(d: Descriptor): string | null;
export function serialize(d: Descriptor, fields: Fields): string;
export function atomicWrite(file: string, data: string | Buffer): void;
export function parseRecord(d: Descriptor, file: string): Fields;
export function parseRecordText(d: Descriptor, text: string): Fields;
export function idFromRecordPath(d: Descriptor, file: string): string;
/** 0 clean · 1 violations · 2 no compiled runtime; prints its report */
export function check(ws: Workspace): 0 | 1 | 2;
export function commitPending(store: Store, opts?: { only?: string[]; message?: string; dryRun?: boolean }): { repo: string; sha?: string; subject: string; rows: { verb: string; collection: string; id: string }[]; blocked?: string; warning?: string; leftPending?: string[] }[];
export function composeSubject(rows: unknown[]): string;
export function history(store: Store, collection: string, id: string): { hash: string; date: string; author: string; subject: string }[];
export function historyDiff(store: Store, collection: string, id: string, hash?: string): { hash: string; path: string; diff: string };
export function deriveEvents(root: string, descriptors: Descriptors, since: string, head?: string): { type: string; collection: string; id: string }[];
export function relationsOf(descriptors: Descriptors): any[];

// ---- values, references and queries ------------------------------------------------------------------

export function matchesFilter(row: Fields, filter: unknown, resolve?: unknown): boolean;
export function unknownOperators(filter: unknown): Set<string>;
export function looseEq(a: unknown, b: unknown): boolean;
export const KNOWN_OPERATORS: readonly string[];
export function sortRows<T>(rows: T[], sort: string | null | undefined): T[];
export function compareValues(a: unknown, b: unknown): number;
export function distinctValues(store: Store, collection: string, field: string, opts?: { limit?: number }): any;
export function keyBetween(a: string | null, b: string | null): string;
export function placementKey(rows: { id: string; key: string }[], id: string, where: Record<string, unknown>, collection: string): string;
export function parseRef(ref: string, namespaces: string[]): { collection: string; id: string } | null;
export function normalizeNamespaces(list: unknown): string[];
export function splitRef(descriptors: Descriptors, ref: string): { collection: string; id: string };
export function canonicalCollection(descriptors: Descriptors, word: string): string | null;
export function refTargetsOf(prop: unknown): string[];
export function slug(s: string): string;
export function slugOrHash(s: string): string;
export function envContext(ws: Workspace): unknown;
export function renderTemplate(template: string, ctx: unknown): string;
export function parseEnvValues(text: string): Map<string, string>;
export function loadYaml(text: string): any;
export function dumpYaml(value: unknown): string;
export function satisfies(version: string, range: string): boolean | null;

// ---- the compiled runtime -------------------------------------------------------------------------

export const RUNTIME_DIR: '.dreamteamer';
export function runtimeDir(root: string): string;
export function readManifest(root: string): Manifest | null;
export function loadDescriptors(root: string): Descriptors;
export function namespaces(root: string): string[];

// ---- the compiler, schema and module operations --------------------------------------------------

/** throws CompileError on a bad source; prints its summary; returns 0 */
export function compile(ws: Workspace): 0;
export function staleness(root: string): { compiled: boolean; stale: string[]; manifest?: Manifest; message?: string };
export function warnIfStale(root: string): ReturnType<typeof staleness>;
export function discoverModules(root: string, pkg: Workspace['pkg']): { modules: { name: string; root: string; channel: string }[]; shadows: unknown[]; disabledModules: string[] };
export class CompileError extends Error {}
export const KINDS: readonly string[];
export const MANAGED_BLOCKS: readonly { id: 'orientation' | 'instructions'; begin: string; end: string }[];
type SchemaOp = (ws: Workspace, store: Store, ...args: any[]) => any;
export const createCollection: SchemaOp, removeCollection: SchemaOp, renameCollection: SchemaOp, moveCollection: SchemaOp, setCollectionScalars: SchemaOp;
export const addField: SchemaOp, updateField: SchemaOp, removeField: SchemaOp, removeFieldPlan: SchemaOp, renameField: SchemaOp, renameFieldPlan: SchemaOp;
export function fieldDef(flags: Record<string, unknown>, ...rest: any[]): any;
export function statedKeywords(flags: Record<string, unknown>): any;
export const saveUiView: SchemaOp, removeUiView: SchemaOp;
export const createModule: SchemaOp, setModule: SchemaOp, renameModule: SchemaOp, removeModule: SchemaOp;
export const createSkill: SchemaOp, refuseHandAuthored: SchemaOp, removeEntity: SchemaOp, renameEntity: SchemaOp, setEntityFrontmatter: SchemaOp;
export function init(opts?: { flags?: Record<string, string> }): 0;
export function ensureRepo(ws: Workspace, id: string): { path: string; cloned: boolean };
export function ensureAllRepos(ws: Workspace): { path: string; cloned: boolean }[];
export function listRepos(ws: Workspace): { id: string; path: string; present: boolean; unresolved?: string }[];
export function installClone(ws: Workspace, url: string, name?: string): number;

// ---- the checkout -------------------------------------------------------------------------------------

export function describeCheckout(root: string, git?: (args: string[], cwd: string) => string): { root: string; kind: 'primary' | 'linked'; gitDir: string; commonDir: string; primary: string; insideRoot: boolean };
export function installCommand(ws: Workspace, argv: string[], opts?: { open?: (at: string) => Promise<Workspace> }): Promise<number>;
export function resolveNpm(execPath?: string, env?: NodeJS.ProcessEnv): string | null;
export function childEnv(): NodeJS.ProcessEnv;
export function readHookInput(stdinText: string): { cwd: string | null; name: string | null; raw: Record<string, unknown> };
export function readStdin(isTTY?: boolean): string;

// ---- read models ---------------------------------------------------------------------------------------

export function presentation(descriptors: Descriptors): { collections: any[]; fields: Record<string, any[]>; relations: any[]; [k: string]: unknown };
export function commandsFor(store: Store, collection: string, ids?: string[]): { commands: any[] };
export function recordResolver(store: Store): (ref: string) => Fields | null;

// ---- CLI helpers ------------------------------------------------------------------------------------------

/** write synchronously, looping on short writes — safe before process.exit */
export function emit(text: string, fd?: number): void;
export function parseArgs(argv: string[]): { flags: Record<string, string | boolean | string[]>; pos: string[] };
