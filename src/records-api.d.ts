// The typed contract of `import … from 'dreamteamer/records'` (src/records-api.js) — the record half:
// records over git and the read models a surface draws. Shapes the engine does not constrain (a
// record's fields, a descriptor's schema) are typed loosely on purpose: they are the workspace's.

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
export type Manifest = { compiled: string; host: string; engine: string; namespaces: string[]; modules: { name: string; location: string; channel: string; root: string }[]; ui: string[]; 'adapter-outputs': string[]; 'adapter-blocks': string[]; extensions?: { name: string; version: string }[]; 'source-kinds'?: { kind: string; exclude: string[]; extension: string }[]; entries: Record<string, { sources: { path: string; hash: string }[]; hash: string }>; [k: string]: unknown };

export const apiVersion: 1;
export function engineVersion(): string;
export function engineId(): string;

// ---- records -------------------------------------------------------------------------------------------

export class Store {
	constructor(ws: { root: string; pkg?: unknown });
	root: string;
	descriptors: Descriptors;
	descriptor(collection: string): Descriptor;
	/** the absolute folder a collection's records live in */
	dir(d: Descriptor): string;
	/** id → record file */
	ids(collection: string): Map<string, string>;
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
export function parseRecord(file: string, d: Descriptor, bodyField?: string | null): Fields;
export function parseRecordText(text: string, d: Descriptor, bodyField?: string | null): Fields;
export function idFromRecordPath(d: Descriptor, file: string): string;
/** 0 clean · 1 violations · 2 no compiled runtime; prints its report */
export function check(ws: { root: string; pkg?: unknown }): 0 | 1 | 2;
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
export const KNOWN_OPERATORS: ReadonlySet<string>;
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
export function loadYaml(text: string): any;
export function dumpYaml(value: unknown): string;

// ---- the compiled runtime -------------------------------------------------------------------------

export const RUNTIME_DIR: '.dreamteamer';
export function runtimeDir(root: string): string;
export function readManifest(root: string): Manifest | null;
export function loadDescriptors(root: string): Descriptors;
export function namespaces(root: string): string[];

// ---- read models ---------------------------------------------------------------------------------------

export function presentation(descriptors: Descriptors): { collections: any[]; fields: Record<string, any[]>; relations: any[]; [k: string]: unknown };
export function commandsFor(store: Store, collection: string, ids?: string[]): { commands: any[] };
export function recordResolver(store: Store): (ref: string) => Fields | null;

