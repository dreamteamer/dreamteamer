// The typed contract of `import … from 'dreamteamer/records'` (src/records-api.js) — the record half:
// records over git and the read models a surface draws. Shapes the engine does not constrain (a
// record's fields, a descriptor's schema) are typed loosely on purpose: they are the workspace's.

export type Fields = Record<string, unknown>;
/** One resolved field, in the descriptor's own vocabulary (see src/fields.js). */
export type Field = {
	type: string | string[];
	title?: string; description?: string; required?: boolean; many?: boolean; default?: unknown;
	enum?: unknown[] | Record<string, { label?: string; description?: string; icon?: string; color?: string; background?: string }>;
	unique?: boolean; mirror_of?: string; on_delete?: 'restrict' | 'set-null'; soft?: boolean; sensitive?: boolean;
	body?: boolean; derived?: boolean; virtual?: boolean; deprecated?: boolean;
	fields?: Record<string, Field>; values?: string | Field; item_title?: string;
	display?: Record<string, unknown>;
	[k: string]: unknown;
};
/** A compiled descriptor: the authored v2 keys plus what compile decided. Read it through the accessors. */
export type Descriptor = {
	name: string;
	title?: string;
	singular?: string;
	record_title?: string;
	description?: string;
	use_when?: string;
	internal?: boolean;
	sensitive?: boolean;
	storage?: { path?: string; format?: 'md' | 'yaml' | 'json' | 'binary'; shape?: 'file' | 'folder'; entry?: string; suffix?: string; under?: { parent: string; subfolder: string; id?: 'independent' | 'nested' }; max_bytes?: number; accept?: string[] };
	ids?: { from?: string | string[]; pattern?: string };
	constraints?: unknown[];
	display?: Record<string, Record<string, unknown>>;
	compiled: {
		defaults: Record<string, unknown>;
		module: string; repo: string; runtime: boolean; under_collection?: string;
		mirrors: string[]; overlaid_by: string[]; unresolved_peers: string[];
		fields: Record<string, Field>;
		json_schema: Record<string, unknown>;
	};
	[k: string]: unknown;
};
export type Storage = { path: string; format: 'md' | 'yaml' | 'json' | 'binary'; shape: 'file' | 'folder'; suffix: string; repo: string; runtime: boolean; entry?: string; max_bytes?: number; accept?: string[]; under?: { parent: string; subfolder: string; collection: string; id: 'independent' | 'nested' } };
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
	/** the collection's OWN folder — for a collection stored under another (`storage.under`) this is
	 *  its fallback root, not an enumeration; records are wherever `ids()` says */
	dir(d: Descriptor): string;
	/** every folder a record of this collection can sit in: its own, plus the parent collection's when
	 *  it is stored under one — what to ask git about */
	recordDirs(d: Descriptor): string[];
	/** id → record file, across every folder the collection's records sit in */
	ids(collection: string): Map<string, string>;
	read(collection: string, id: string): { fields: Fields; file: string };
	readAll(collection: string): Iterable<{ id: string; fields: Fields; file: string }>;
	/** A record's `created`: the stamp when present, else the date its id was made from, else the first commit holding the file. Undefined when the collection has no `created` field or no commit holds the file. */
	createdOf(collection: string, id: string, fields: Fields, file: string): string | undefined;
	add(collection: string, fields: Fields, opts?: { id?: string }): { id: string; file: string; idFallback?: unknown };
	addFile(collection: string, id: string, from: string, opts?: { force?: boolean }): { id: string; file: string };
	set(collection: string, id: string, changes: Fields): unknown;
	rm(collection: string, id: string, opts?: { force?: boolean }): { inboundIgnored: number };
	rename(collection: string, oldId: string, newId: string): { id: string; rewrites: number; touched: number };
	revert(collection: string, id: string, hash: string): { reverted: boolean };
	/** the files `relocate` would move — read-only */
	relocatePlan(collection: string, only?: string[] | null): { collection: string; moves: { id: string; from: string; to: string; why: 'placement' | 'shape' }[]; problems: string[] };
	/** move record files to where the compiled descriptor puts them; ids and references unchanged */
	relocate(collection: string, opts?: { only?: string[] | null; dryRun?: boolean }): { collection: string; moves: { id: string; from: string; to: string; why: 'placement' | 'shape' }[]; problems: string[]; applied: boolean };
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
export function check(ws: { root: string; pkg?: unknown }, opts?: { extra?: { file: string; msg: string }[] }): 0 | 1 | 2;
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
export function sortRows<T>(rows: T[], sort: string | null | undefined, jsonSchema?: Record<string, unknown>): T[];
export function compareValues(a: unknown, b: unknown): number;
export function distinctValues(store: Store, collection: string, field: string, opts?: { limit?: number }): any;
export function keyBetween(a: string | null, b: string | null): string;
export function placementKey(rows: { id: string; key: string }[], id: string, where: Record<string, unknown>, collection: string): string;
export function parseRef(ref: string, namespaces: string[]): { collection: string; id: string } | null;
export function normalizeNamespaces(list: unknown): string[];
export function splitRef(descriptors: Descriptors, ref: string): { collection: string; id: string };
export function canonicalCollection(descriptors: Descriptors, word: string): string | null;
// ---- descriptor accessors (src/descriptor.js) — the one way to ask a compiled descriptor -----------
export function fieldsOf(d: Descriptor): Record<string, Field>;
export function storedFieldsOf(d: Descriptor): Record<string, Field>;
export function jsonSchemaOf(d: Descriptor): Record<string, unknown>;
export function bodyFieldOf(d: Descriptor): string | undefined;
export function positionFieldOf(d: Descriptor): string | undefined;
export function requiredOf(d: Descriptor): string[];
export function targetsOf(field: Field | undefined): null | '*' | string[];
export function isSoft(field: Field | undefined): boolean;
export function mirrorOf(field: Field | undefined): string | undefined;
export function titleOf(d: Descriptor): string;
export function singularOf(d: Descriptor): string | undefined;
export function recordTitleOf(d: Descriptor): string;
export function idsOf(d: Descriptor): { from?: string | string[]; pattern?: string };
export function storageOf(d: Descriptor): Storage;
export function isRuntime(d: Descriptor): boolean;
export function isInternal(d: Descriptor): boolean;
export function isSensitive(d: Descriptor): boolean;
export function isBinary(d: Descriptor): boolean;
export function displayOf(d: Descriptor): Record<string, Record<string, unknown>>;
export function moduleOf(d: Descriptor): string;
export function overlaidByOf(d: Descriptor): string[];
export function unresolvedPeersOf(d: Descriptor): string[];
export function mirrorsOf(d: Descriptor): string[];
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

/** The display contract (descriptor v2, design §4.3): what every surface draws from. */
export interface PresentationChoice { label: string; value: string; description?: string; icon?: string; color?: string; background?: string }
export interface PresentationComponentOptions { choices?: PresentationChoice[]; fields?: PresentationField[]; item_title?: string; [option: string]: unknown }
export interface PresentationField {
	collection?: string;
	field: string;
	type: 'string' | 'markdown' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'url' | 'email' | 'object' | 'map' | 'position';
	many?: true;
	title: string;
	description?: string;
	required: boolean;
	kind?: 'derived' | 'virtual' | 'mirror';
	editable: boolean | 'create';
	hidden?: Array<'list' | 'form' | 'record'>;
	role?: 'body' | 'reference' | 'reference_many' | 'mirror';
	editor?: string;
	editor_options?: PresentationComponentOptions;
	viewer?: string;
	viewer_options?: PresentationComponentOptions;
	mirror_of?: string;
	on_delete?: string;
	unique?: true;
	nullable: boolean;
	default?: unknown;
	unit?: string;
	unit_field?: string;
	direction?: 'ltr' | 'rtl';
	width?: number;
	placeholder?: string;
	form_section?: string;
	deprecated?: true;
	sensitive?: true;
}
export interface PresentationCollection {
	collection: string;
	title: string;
	nav: { icon?: string; order?: number; section?: string };
	list: { layout: string; columns?: string[]; sort?: string; options?: Record<string, unknown> };
	record: { layout: string; subtitle?: string; badge?: string; color_by?: string };
	form: { sections: Array<{ title: string; fields: string[] }> };
	position_field?: string;
	record_title?: string;
	record_type: string;
	runtime: boolean;
	internal: boolean;
}
export interface PresentationRelation { collection: string; field: string; related_collection: string; list: boolean; kind?: 'm2o' | 'o2o' | 'm2m'; mirror?: true }
export interface Presentation { collections: PresentationCollection[]; fields: Record<string, PresentationField[]>; relations: PresentationRelation[] }
export function presentation(descriptors: Descriptors): Presentation;
export function commandsFor(store: Store, collection: string, ids?: string[]): { commands: any[] };
export function recordResolver(store: Store): (ref: string) => Fields | null;

